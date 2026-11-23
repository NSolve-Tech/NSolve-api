# NSolve API

Backend API untuk portal siswa dan guru NSolve-Tech. PostgreSQL adalah database utama; API tidak lagi menjalankan SQLite.

## Prasyarat

- Node.js 22.5 atau lebih baru
- PostgreSQL 15 atau lebih baru untuk development lokal

## Menjalankan secara lokal

1. Buat database PostgreSQL lokal:

   ```sql
   CREATE USER nsolve WITH PASSWORD 'ganti-password-lokal';
   CREATE DATABASE nsolve OWNER nsolve;
   ```

   Jalankan perintah tersebut melalui `psql` atau SQL client seperti DBeaver.

2. Salin `.env.example` menjadi `.env`, lalu isi `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, dan `JWT_SECRET`. Secret JWT harus sekurangnya 32 byte. Untuk PostgreSQL lokal, gunakan `DATABASE_SSL=false`.

3. Instal dependensi, buat tabel, dan muat data development:

   ```bash
   npm install
   npm run migrate
   npm run seed
   ```

4. Jalankan API:

   ```bash
   npm run dev
   ```

   Health check tersedia di `http://localhost:3001/health`, dengan respons:

   ```json
   { "status": "ok", "database": "postgres" }
   ```

Frontend siswa/guru dan panel admin menggunakan API yang sama. Pastikan `VITE_API_URL` pada kedua frontend menunjuk ke origin API, misalnya `http://localhost:3001`. Default development CORS mengizinkan `http://localhost:5173` dan `http://localhost:5174`; daftarkan origin deployment kedua aplikasi melalui `FRONTEND_ORIGINS` pada production.

Panel admin terpisah berada di direktori `../NSolve-admin-fe`. Untuk menjalankannya:

```bash
npm install --prefix ../NSolve-admin-fe
npm run dev --prefix ../NSolve-admin-fe
```

Panel admin tersedia pada `http://localhost:5174` dan hanya dapat diakses akun dengan role Admin.

## PostgreSQL ter-host

Railway dan Supabase dapat dikonfigurasi dengan `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, dan `DATABASE_SSL=true`. Alternatifnya, isi `DATABASE_URL` dengan connection string PostgreSQL dan set `DATABASE_SSL=true` bila penyedia mewajibkan TLS. Untuk Neon, gunakan `DATABASE_URL` (koneksi pooled) saat API berjalan dan `DATABASE_URL_UNPOOLED` (koneksi langsung) untuk migrasi. `npm run migrate` otomatis memilih `DATABASE_URL_UNPOOLED` bila tersedia. Jangan commit file `.env` atau kredensial database.

Terapkan migrasi sebelum merilis versi API baru:

```bash
npm run migrate
```

Jalankan `npm run seed` hanya untuk mengisi skenario development. Seed demo tidak boleh diaktifkan pada production (`SEED_DEMO_DATA=false`).

## Deploy ke Vercel

Vercel dapat menjalankan Express API dari `index.js` sebagai satu Vercel Function. Hubungkan repo API, gunakan root directory repo, dan biarkan framework terdeteksi otomatis. Atur environment variables `NODE_ENV=production`, `SEED_DEMO_DATA=false`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_SSL=true`, `JWT_SECRET`, `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=None`, `TRUST_PROXY=true`, dan `FRONTEND_ORIGINS` ke origin frontend tanpa trailing slash. Gunakan koneksi pooled Neon untuk `DATABASE_URL`, koneksi langsung untuk `DATABASE_URL_UNPOOLED`, dan jalankan `npm run migrate` secara manual sebelum deploy schema baru.

## Memindahkan data SQLite lama

1. Cadangkan file SQLite lama dan konfigurasi koneksi PostgreSQL pada `.env`.
2. Terapkan schema PostgreSQL terlebih dahulu dengan `npm run migrate`.
3. Impor data menggunakan Node.js 22.5+:

   ```bash
   npm run migrate:sqlite -- /path/ke/nsolve.sqlite
   ```

   Tanpa argumen, script mencoba `server/data/student.sqlite`; atau gunakan variabel `SQLITE_SOURCE`. Script hanya membaca SQLite dan mengimpor tabel akun, sesi, ujian, jawaban, hasil, serta tabel workflow guru yang tersedia. Periksa jumlah baris hasil dan hasil login setelah impor sebelum mengarsipkan database lama.

## Multi-tenant and class access

Schema mencakup `schools`, `teachers`, `students`, `classes`, dan `subjects`. Siswa harus memilih sekolah dan kelas saat mendaftar; keanggotaan kelas tersebut menentukan ujian yang muncul pada dashboard. Administrator sekolah menetapkan kelas ajar melalui `teacher_classes`, dan guru hanya dapat memilih kelas yang ditugaskan saat membuat ujian. Data ujian, hasil, keanggotaan, dan log aktivitas dibatasi ke tenant sekolah.

Pemantauan perpindahan tab, fokus jendela, keluar dari fullscreen, dan tombol PrintScreen bersifat best-effort karena browser dan sistem operasi tidak menyediakan deteksi screenshot yang menyeluruh. Aktivitas yang berhasil dilaporkan tampil pada panel pengawasan admin.

## API dan pengujian

Daftar endpoint dan payload tersedia pada [docs/API.md](./docs/API.md). Tes integrasi menggunakan PostgreSQL embedded khusus test:

```bash
npm test
```

Untuk provisioning akun Guru Emma pada database yang telah dimigrasikan:

```bash
npm run create-teacher
```

CLI meminta email dan password melalui terminal interaktif; password tidak dicetak.

Untuk membuat akun Admin Platform NSolve yang dapat mengelola semua sekolah, jalankan:

```bash
npm run create-admin
```

CLI meminta nama, email, ID akun, dan password melalui terminal interaktif; password tidak dicetak. ID default adalah `jk-23.11.2026-15.16`. Admin Platform dapat memilih sekolah dari dashboard Admin.
