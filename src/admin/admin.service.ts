import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SearchConfiguration } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

type Filters = Record<string, number | null>;
type SourceModule = {
  id: string;
  key: string;
  name: string;
  note: string;
  fields: unknown[];
};
const registry: {
  modules: SourceModule[];
  definition: (id: string) => SourceModule | undefined;
  defaults: (id: string) => Filters;
  validate: (id: string, input: unknown) => Filters;
} = require("../../scripts/search-settings.cjs");

@Injectable()
export class AdminService {
  constructor(private readonly db: PrismaService) {}

  async overview() {
    const [sources, delivery] = await Promise.all([
      this.db.source.findMany({
        where: { id: { in: registry.modules.map((m) => m.id) } },
        include: {
          search: true,
          runs: { orderBy: { startedAt: "desc" }, take: 10 },
          _count: { select: { listings: true } },
        },
      }),
      this.db.notificationOutbox.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);
    return {
      updatedAt: new Date(),
      deliveryEnabled: process.env.TELEGRAM_DELIVERY_ENABLED === "true",
      delivery: delivery.map((d) => ({
        status: d.status,
        count: d._count._all,
      })),
      sources: registry.modules.map((module) => {
        const source = sources.find((s) => s.id === module.id);
        const runtimeAvailable =
          (module.key !== "huurwoningen" || Boolean(process.env.HUURWONINGEN_BROWSER_ORIGIN)) &&
          (module.key !== "pararius" || Boolean(process.env.PARARIUS_BROWSER_ORIGIN));
        const runtimeEnabled = !(
          (module.key === "vesteda" &&
            process.env.VESTEDA_MONITORING_ENABLED === "false") ||
          (module.key === "solide" &&
            process.env.SOLIDE_MONITORING_ENABLED === "false") ||
          (module.key === "rentola" &&
            process.env.RENTOLA_MONITORING_ENABLED === "false") ||
          (module.key === "rentsolutions" &&
            process.env.RENTSOLUTIONS_MONITORING_ENABLED === "false") ||
          (module.key === "maxx" &&
            process.env.MAXX_MONITORING_ENABLED === "false") ||
          (module.key === "vandermeulen" &&
            process.env.VANDERMEULEN_MONITORING_ENABLED === "false") ||
          (module.key === "lamberink" &&
            process.env.LAMBERINK_MONITORING_ENABLED === "false") ||
          (module.key === "gruno" &&
            process.env.GRUNO_MONITORING_ENABLED === "false")
        );
        return {
          module,
          ready: Boolean(source),
          runtimeAvailable,
          runtimeEnabled,
          settings: source?.search
            ? this.publicSettings(source.search)
            : {
                enabled: true,
                filters: registry.defaults(module.id),
                revision: 0,
                appliedRevision: 0,
              },
          health: source
            ? {
                status: source.status,
                lastAttemptAt: source.lastAttemptAt,
                lastSuccessAt: source.lastSuccessAt,
                nextCheckAt: source.nextCheckAt,
                running:
                  source.monitorLeaseUntil !== null &&
                  source.monitorLeaseUntil > new Date(),
                listings: source._count.listings,
                runs: source.runs.map((r) => ({
                  id: r.id,
                  status: r.status,
                  startedAt: r.startedAt,
                  finishedAt: r.finishedAt,
                  listingsFound: r.listingsFound,
                  errorCategory: r.errorCategory,
                  searchRevision: r.searchRevision,
                })),
              }
            : null,
        };
      }),
    };
  }

  async save(id: string, input: unknown) {
    if (!registry.definition(id))
      throw new NotFoundException("Неизвестный источник");
    if (!input || typeof input !== "object")
      throw new BadRequestException("Некорректные настройки");
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (k) => !["revision", "enabled", "filters"].includes(k),
      ) ||
      !Number.isInteger(body.revision) ||
      Number(body.revision) < 0 ||
      typeof body.enabled !== "boolean"
    )
      throw new BadRequestException("Некорректные настройки");
    let filters: Filters;
    try {
      filters = registry.validate(id, body.filters);
    } catch {
      throw new BadRequestException(
        "Проверьте значения фильтров и диапазон аренды",
      );
    }
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Source" WHERE id = ${id} FOR UPDATE`;
      if (!rows.length)
        throw new ConflictException(
          "Источник ещё не инициализирован приложением",
        );
      let current = await tx.searchConfiguration.findUnique({
        where: { sourceId: id },
      });
      if ((current?.revision ?? 0) !== body.revision)
        throw new ConflictException(
          "Настройки изменились. Обновите страницу перед сохранением",
        );
      if (
        current &&
        current.enabled === body.enabled &&
        JSON.stringify(registry.validate(id, current.filters)) ===
          JSON.stringify(filters)
      )
        return this.publicSettings(current);
      const data = {
        enabled: body.enabled as boolean,
        filters: filters as Prisma.InputJsonObject,
      };
      current = current
        ? await tx.searchConfiguration.update({
            where: { sourceId: id },
            data: { ...data, revision: { increment: 1 } },
          })
        : await tx.searchConfiguration.create({
            data: { sourceId: id, ...data, appliedRevision: 0 },
          });
      await tx.searchChange.create({
        data: {
          sourceId: id,
          revision: current.revision,
          ...data,
          actor: "admin",
        },
      });
      // Don't alter an existing run or bypass BLOCKED cooldown when editing filters.
      await tx.source.updateMany({
        where: { id, status: { not: "BLOCKED" }, monitorLeaseToken: null },
        data: { nextCheckAt: new Date() },
      });
      return this.publicSettings(current);
    });
  }

  async history(id: string) {
    if (!registry.definition(id)) throw new NotFoundException();
    return this.db.searchChange.findMany({
      where: { sourceId: id },
      orderBy: { revision: "desc" },
      take: 30,
      select: {
        revision: true,
        enabled: true,
        filters: true,
        actor: true,
        createdAt: true,
      },
    });
  }
  private publicSettings(s: SearchConfiguration) {
    return {
      enabled: s.enabled,
      filters: s.filters,
      revision: s.revision,
      appliedRevision: s.appliedRevision,
      updatedAt: s.updatedAt,
    };
  }
}
