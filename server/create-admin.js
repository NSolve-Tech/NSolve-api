import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createDatabase } from "./database.js";
import { loadConfig } from "./config.js";

const scrypt = promisify(scryptCallback);
const DEFAULT_ADMIN_ID = "jk-23.11.2026-15.16";

function ask(prompt) {
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => interface_.question(prompt, (value) => {
    interface_.close();
    resolve(value.trim());
  }));
}

function askPassword(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Buat akun Admin melalui terminal interaktif agar kata sandi tidak tampil.");
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let value = "";
    const input = process.stdin;
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const key = chunk.toString();
      if (key === "\u0003") {
        finish(new Error("Pembuatan akun dibatalkan."));
      } else if (key === "\r" || key === "\n") {
        finish();
      } else if (key === "\u007f") {
        value = value.slice(0, -1);
      } else if (key.length === 1 && key >= " ") {
        value += key;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const database = createDatabase(loadConfig().database);
try {
  console.log("Akun ini adalah Admin Platform dan dapat mengelola semua sekolah.");
  const fullName = await ask("Nama Admin: ");
  if (fullName.length < 2 || fullName.length > 120) {
    throw new Error("Nama harus terdiri dari 2 sampai 120 karakter.");
  }
  const email = (await ask("Email akun Admin: ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Alamat email tidak valid.");
  }
  const requestedId = await ask(`ID akun Admin [${DEFAULT_ADMIN_ID}]: `);
  const adminId = requestedId || DEFAULT_ADMIN_ID;
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(adminId)) {
    throw new Error("ID akun Admin hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung.");
  }
  const password = await askPassword("Kata sandi (minimal 12 karakter): ");
  if (password.length < 12 || password.length > 128) {
    throw new Error("Kata sandi harus terdiri dari 12 sampai 128 karakter.");
  }
  const { rows: [existingUser] } = await database.query(
    "SELECT id, email FROM users WHERE lower(email) = $1 OR id = $2",
    [email, adminId],
  );
  if (existingUser) {
    throw new Error(existingUser.email.toLowerCase() === email
      ? "Email sudah terdaftar."
      : "ID akun Admin sudah digunakan.");
  }

  const passwordSalt = randomBytes(16).toString("hex");
  const passwordHash = Buffer.from(await scrypt(password, passwordSalt, 64)).toString("hex");
  await database.query(`
    INSERT INTO users (
      id, full_name, email, password_salt, password_hash, created_at, role, school_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 'admin', NULL)
  `, [adminId, fullName, email, passwordSalt, passwordHash, new Date()]);
  console.log(`Akun Admin Platform berhasil dibuat dengan ID ${adminId}.`);
} finally {
  await database.end();
}
