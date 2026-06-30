/**
 * CLI: bootstrap the single Owner user. There is NO UI signup flow (no one is
 * logged in on first run). Ships with an otherwise empty database — no seed data.
 *
 * Usage:
 *   ADMIN_NAME="Jane" ADMIN_EMAIL="jane@co.com" ADMIN_PASSWORD="..." npm run bootstrap:admin
 *   # or interactively:
 *   npm run bootstrap:admin
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/password.js";

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  if (hidden) {
    // Best-effort masking for the password prompt.
    const onData = () => {
      stdout.write("\x1b[2K\r" + question);
    };
    stdin.on("data", onData);
    const answer = await rl.question(question);
    stdin.off("data", onData);
    rl.close();
    stdout.write("\n");
    return answer;
  }
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function main() {
  const firstName = process.env.ADMIN_FIRST_NAME ?? (await prompt("Admin first name: "));
  const lastName = process.env.ADMIN_LAST_NAME ?? (await prompt("Admin last name: "));
  const phone = process.env.ADMIN_PHONE ?? (await prompt("Admin phone number: "));
  const emailRaw = process.env.ADMIN_EMAIL ?? (await prompt("Admin email: "));
  const password = process.env.ADMIN_PASSWORD ?? (await prompt("Admin password (min 8 chars): ", true));

  const email = emailRaw.trim().toLowerCase();
  if (!firstName.trim() || !lastName.trim() || !phone.trim() || !email || password.length < 8) {
    console.error("First name, last name, phone, a valid email, and a password of at least 8 characters are required.");
    process.exit(1);
  }
  const name = `${firstName.trim()} ${lastName.trim()}`;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`A user with email ${email} already exists. Aborting.`);
    process.exit(1);
  }

  const ownerCount = await prisma.user.count({ where: { role: "OWNER" } });
  const user = await prisma.user.create({
    data: {
      name,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
      email,
      passwordHash: await hashPassword(password),
      role: "OWNER",
      status: "ACTIVE",
    },
  });

  console.log(`\n✅ Created Owner user: ${user.name} <${user.email}>`);
  if (ownerCount > 0) console.log("   (note: other Owner accounts already existed)");
  console.log("   You can now log in to the app.\n");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
