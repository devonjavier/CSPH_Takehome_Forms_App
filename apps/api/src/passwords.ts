import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt);
  return `scrypt$32768$8$1$${salt}$${key.toString("hex")}`;
}

// Also used for unknown accounts so login still performs the expensive hash.
export const dummyPasswordHash = `scrypt$32768$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(
    encoded,
  );
  const salt = match?.[1];
  const expected = match?.[2];
  if (!salt || !expected) return false;
  // Seed hashes pass the hexadecimal salt as a UTF-8 string, not decoded bytes.
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
