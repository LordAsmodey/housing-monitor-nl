import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Req,
  Res,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  Inject,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { AdminService } from "./admin.service";
const auth = require("../../scripts/admin-auth.cjs");
type Request = {
  headers: Record<string, string | undefined>;
  socket: { remoteAddress?: string };
};
type Response = { setHeader: (name: string, value: string) => void };

@Controller("api/admin")
export class AdminController {
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}
  private configured() {
    return Boolean(process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD);
  }
  private headers(res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  private async session(req: Request, res: Response, mutating = false) {
    this.headers(res);
    if (!this.configured()) throw new UnauthorizedException();
    const token = auth.cookieToken(req.headers.cookie);
    if (!token) throw new UnauthorizedException();
    const session = await this.db.adminSession.findUnique({
      where: { tokenHash: auth.hash(token) },
    });
    if (!session || session.expiresAt <= new Date())
      throw new UnauthorizedException();
    if (mutating && !auth.equal(req.headers["x-csrf-token"], session.csrf))
      throw new ForbiddenException();
    return session;
  }
  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.headers(res);
    if (!this.configured())
      throw new UnauthorizedException("Админка не настроена");
    // Require same-site JSON fetch. Login has no session CSRF token yet.
    if (
      !req.headers["content-type"]?.startsWith("application/json") ||
      req.headers["x-admin-request"] !== "1" ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new ForbiddenException();
    const now = Date.now();
    for (const [key, v] of this.attempts)
      if (v.until < now) this.attempts.delete(key);
    const key = req.socket.remoteAddress ?? "unknown";
    const attempt = this.attempts.get(key) ?? {
      count: 0,
      until: now + 15 * 60000,
    };
    if (attempt.count >= 10 || this.attempts.size >= 10000)
      throw new HttpException("Слишком много попыток. Повторите позже", 429);
    attempt.count++;
    this.attempts.set(key, attempt);
    const b = body as { login?: unknown; password?: unknown } | null;
    if (
      !b ||
      !auth.equal(b.login, process.env.ADMIN_LOGIN) ||
      !auth.equal(b.password, process.env.ADMIN_PASSWORD)
    )
      throw new UnauthorizedException("Неверный логин или пароль");
    this.attempts.delete(key);
    await this.db.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const { token, ...session } = auth.newSession();
    await this.db.adminSession.create({ data: session });
    res.setHeader("Set-Cookie", this.cookie(token));
    return { csrf: session.csrf };
  }
  private cookie(token: string) {
    return `hm_admin=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  }
  @Get("session")
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.session(req, res);
    return { csrf: s.csrf };
  }
  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.session(req, res, true);
    await this.db.adminSession.deleteMany({
      where: { tokenHash: s.tokenHash },
    });
    res.setHeader("Set-Cookie", this.cookie(""));
    return { ok: true };
  }
  @Get("overview")
  async overview(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.session(req, res);
    return this.admin.overview();
  }
  @Put("sources/:id")
  async save(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.session(req, res, true);
    return this.admin.save(id, body);
  }
  @Get("sources/:id/history")
  async history(
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.session(req, res);
    return this.admin.history(id);
  }
}
