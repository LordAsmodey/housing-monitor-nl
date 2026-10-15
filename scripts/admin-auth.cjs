"use strict";
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function newSession() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hash(token),
    csrf: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 8 * 3600000),
  };
}
function cookieToken(header = "") {
  const value = header
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("hm_admin="))
    ?.slice(9);
  return /^[a-f0-9]{64}$/.test(value ?? "") ? value : undefined;
}
module.exports = { hash, equal, newSession, cookieToken };
