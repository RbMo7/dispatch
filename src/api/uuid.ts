const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every Dispatch id is a Postgres `uuid`, which reads either case; anything else can never name one. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
