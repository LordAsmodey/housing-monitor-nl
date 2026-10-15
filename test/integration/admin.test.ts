import "reflect-metadata";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaService } from "../../src/database/prisma.service";
import { ListingsService } from "../../src/listings/listings.service";
import { AdminService } from "../../src/admin/admin.service";
import { AdminController } from "../../src/admin/admin.controller";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
const { runFunda } = require("../../scripts/funda-runner.cjs");
const registry = require("../../scripts/search-settings.cjs");
assert.ok(
  process.env.DATABASE_URL,
  "Supply a disposable DATABASE_URL; never load .env",
);
const db = new PrismaService(),
  listings = new ListingsService(db),
  admin = new AdminService(db);
const id = "funda:groningen-30km-1500-3d";
const item = (externalId: string, areaM2 = 60) => ({
  externalId,
  canonicalUrl: `https://example.com/${externalId}`,
  title: "Test",
  city: "Groningen",
  rentPrice: 900,
  areaM2,
});
after(async () => {
  await db.notificationOutbox.deleteMany({
    where: { listing: { sourceId: id } },
  });
  await db.housingListing.deleteMany({ where: { sourceId: id } });
  await db.monitoringRun.deleteMany({ where: { sourceId: id } });
  await db.siteProfile.deleteMany({ where: { sourceId: id } });
  await db.source.deleteMany({ where: { id } });
  await db.$disconnect();
});
test("filter changes suppress history; future matching listings notify; disabled searches never collect", async () => {
  const run = (items: ReturnType<typeof item>[]) =>
    runFunda(db, listings, {
      destination: "-123",
      collector: async () => ({ listings: items, inspected: items.length }),
    });
  const due = () =>
    db.source.update({ where: { id }, data: { nextCheckAt: new Date(0) } });
  await run([item("initial")]);
  await admin.save(id, {
    revision: 1,
    enabled: true,
    filters: { ...registry.defaults(id), maxRent: 1800, minArea: 50 },
  });
  await run([item("initial"), item("old-newly-visible")]);
  assert.equal(
    await db.notificationOutbox.count({ where: { listing: { sourceId: id } } }),
    0,
  );
  await due();
  await run([
    item("initial"),
    item("old-newly-visible"),
    item("future"),
    item("too-small", 30),
  ]);
  assert.equal(
    await db.notificationOutbox.count({ where: { listing: { sourceId: id } } }),
    1,
  );
  await assert.rejects(
    admin.save(id, {
      revision: 1,
      enabled: true,
      filters: registry.defaults(id),
    }),
    /Настройки изменились/,
  );
  const current = await db.searchConfiguration.findUniqueOrThrow({
    where: { sourceId: id },
  });
  await admin.save(id, {
    revision: current.revision,
    enabled: false,
    filters: current.filters,
  });
  await due();
  let calls = 0;
  const skipped = await runFunda(db, listings, {
    destination: "-123",
    collector: async () => {
      calls++;
      return { listings: [], inspected: 0 };
    },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(calls, 0);
});
test("an in-flight run retains its snapshot; newer edits remain unapplied after its completion", async () => {
  let current = await db.searchConfiguration.findUniqueOrThrow({
    where: { sourceId: id },
  });
  await admin.save(id, {
    revision: current.revision,
    enabled: true,
    filters: registry.defaults(id),
  });
  await db.source.update({ where: { id }, data: { nextCheckAt: new Date(0) } });
  const revision = current.revision + 1;
  await runFunda(db, listings, {
    destination: "-123",
    collector: async ({ settings }: { settings: unknown }) => {
      assert.deepEqual(settings, registry.defaults(id));
      await admin.save(id, {
        revision,
        enabled: true,
        filters: { ...registry.defaults(id), minArea: 80 },
      });
      return { listings: [item("in-flight")], inspected: 1 };
    },
  });
  current = await db.searchConfiguration.findUniqueOrThrow({
    where: { sourceId: id },
  });
  assert.equal(current.revision, revision + 1);
  assert.notEqual(current.appliedRevision, current.revision);
  const last = await db.monitoringRun.findFirstOrThrow({
    where: { sourceId: id },
    orderBy: { startedAt: "desc" },
  });
  assert.equal(last.searchRevision, revision);
  assert.equal(
    await db.notificationOutbox.count({
      where: { listing: { sourceId: id, externalId: "in-flight" } },
    }),
    0,
  );
});
test("failed collection does not apply a pending settings revision", async () => {
  const before = await db.searchConfiguration.findUniqueOrThrow({
    where: { sourceId: id },
  });
  const source = await db.source.findUniqueOrThrow({ where: { id } });
  await db.source.update({ where: { id }, data: { nextCheckAt: new Date(0) } });
  await assert.rejects(
    runFunda(db, listings, {
      destination: "-123",
      collector: async () => {
        throw Error("upstream failure");
      },
    }),
    /RUN_FAILED/,
  );
  const after = await db.searchConfiguration.findUniqueOrThrow({
    where: { sourceId: id },
  });
  assert.equal(after.appliedRevision, before.appliedRevision);
  assert.deepEqual(
    (await db.source.findUniqueOrThrow({ where: { id } })).lastSuccessAt,
    source.lastSuccessAt,
  );
});
test("HTTP login protects reads, rejects missing CSRF and invalidates sessions on logout", async () => {
  @Module({
    controllers: [AdminController],
    providers: [
      { provide: PrismaService, useValue: db },
      { provide: AdminService, useValue: admin },
    ],
  })
  class TestAdminModule {}
  const original = {
    login: process.env.ADMIN_LOGIN,
    password: process.env.ADMIN_PASSWORD,
  };
  process.env.ADMIN_LOGIN = "Admin";
  process.env.ADMIN_PASSWORD = "Admin";
  const app = await NestFactory.create(TestAdminModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    assert.equal((await fetch(url + "/api/admin/overview")).status, 401);
    const headers = {
      "Content-Type": "application/json",
      "X-Admin-Request": "1",
    };
    assert.equal(
      (
        await fetch(url + "/api/admin/login", {
          method: "POST",
          headers,
          body: JSON.stringify({ login: "Admin", password: "wrong" }),
        })
      ).status,
      401,
    );
    const login = await fetch(url + "/api/admin/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ login: "Admin", password: "Admin" }),
    });
    assert.equal(login.status, 201);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const session = (await login.json()) as { csrf: string };
    const authenticated = { ...headers, Cookie: cookie.split(";")[0]! };
    assert.equal(
      (await fetch(url + "/api/admin/overview", { headers: authenticated }))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(url + "/api/admin/logout", {
          method: "POST",
          headers: authenticated,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/admin/logout", {
          method: "POST",
          headers: { ...authenticated, "X-CSRF-Token": session.csrf },
        })
      ).status,
      201,
    );
    assert.equal(
      (await fetch(url + "/api/admin/overview", { headers: authenticated }))
        .status,
      401,
    );
  } finally {
    await app.close();
    if (original.login === undefined) delete process.env.ADMIN_LOGIN;
    else process.env.ADMIN_LOGIN = original.login;
    if (original.password === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original.password;
  }
});
