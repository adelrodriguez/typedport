// Defaults are the fixed credentials of the local QStash dev server
// (`npx @upstash/qstash-cli dev`). Point the env vars at a real QStash
// project, and APP_URL at a public URL, to run against production.
export const env = {
  APP_URL: process.env.APP_URL ?? "http://localhost:4323",
  QSTASH_CURRENT_SIGNING_KEY:
    process.env.QSTASH_CURRENT_SIGNING_KEY ?? "sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r",
  QSTASH_NEXT_SIGNING_KEY:
    process.env.QSTASH_NEXT_SIGNING_KEY ?? "sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs",
  QSTASH_TOKEN:
    process.env.QSTASH_TOKEN
    ?? "eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=",
  QSTASH_URL: process.env.QSTASH_URL ?? "http://127.0.0.1:8080",
}
