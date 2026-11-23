import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createDatabase, withTransaction } from "./database.js";
import { loadConfig } from "./config.js";

const scrypt = promisify(scryptCallback);

function ask(prompt) {
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => interface_.question(prompt, (value) => {
    interface_.close();
    resolve(value.trim());
  }));
}

function askPassword(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Buat akun Guru melalui terminal interaktif agar kata sandi tidak tampil.");
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

const config = loadConfig();
const database = createDatabase(config.database);
try {
  const { rows: schools } = await database.query(`
    SELECT id, name FROM schools
    WHERE is_active = TRUE ORDER BY name
  `);
  if (!schools.length) throw new Error("Buat dan aktifkan sekolah terlebih dahulu.");
  console.log("Sekolah aktif:");
  for (const school of schools) console.log(`${school.id} — ${school.name}`);
  const schoolId = await ask("Kode sekolah: ");
  const school = schools.find((item) => item.id === schoolId);
  if (!school) throw new Error("Kode sekolah tidak ditemukan atau sekolah nonaktif.");
  const fullName = await ask("Nama Guru: ");
  if (fullName.length < 2 || fullName.length > 120) {
    throw new Error("Nama Guru harus terdiri dari 2 sampai 120 karakter.");
  }
  const email = (await ask("Email akun Guru: ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Alamat email tidak valid.");
  }
  const subject = await ask("Mata pelajaran: ");
  if (subject.length < 2 || subject.length > 100) {
    throw new Error("Mata pelajaran harus terdiri dari 2 sampai 100 karakter.");
  }
  const positionTitle = await ask("Jabatan (default Guru): ") || "Guru";
  const password = await askPassword("Kata sandi (minimal 12 karakter): ");
  if (password.length < 12 || password.length > 128) {
    throw new Error("Kata sandi harus terdiri dari 12 sampai 128 karakter.");
  }
  const { rows: [existingUser] } = await database.query(
    "SELECT 1 FROM users WHERE lower(email) = $1",
    [email],
  );
  if (existingUser) {
    throw new Error("Email sudah terdaftar. Hubungi administrator untuk pengaturan role.");
  }

  const now = new Date();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = Buffer.from(await scrypt(password, salt, 64)).toString("hex");
  const userId = randomUUID();
  const teacherId = randomUUID();
  await withTransaction(database, async (client) => {
    const { rows: [activeSchool] } = await client.query(
      "SELECT id FROM schools WHERE id = $1 AND is_active = TRUE FOR UPDATE",
      [schoolId],
    );
    if (!activeSchool) throw new Error("Sekolah tidak aktif atau tidak tersedia.");
    const { rows: [schoolSubject] } = await client.query(`
      INSERT INTO subjects (id, school_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [randomUUID(), schoolId, subject]);
    await client.query(`
      INSERT INTO users
        (id, full_name, email, password_salt, password_hash, created_at, role, school_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'teacher', $7)
    `, [userId, fullName, email, salt, passwordHash, now, schoolId]);
    await client.query(`
      INSERT INTO teachers (
        id, user_id, full_name, school_id, subject_id, subject, position_title, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [teacherId, userId, fullName, schoolId, schoolSubject.id, subject, positionTitle, now]);
  });
  console.log(`Akun Guru ${fullName} berhasil dibuat untuk ${school.name}.`);
  console.log("Atur kelas mengajar melalui halaman Penugasan Guru sebelum Guru membuat ujian.");
} finally {
  await database.end();
}
