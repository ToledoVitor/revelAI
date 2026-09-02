import { AthleteIdentityHeaderSchema } from "@revelai/contracts";

const athleteStorageKey = "revelai.device-athlete-id";

function isAthleteId(value: string | null): value is string {
  return (
    value !== null &&
    AthleteIdentityHeaderSchema.safeParse({
      "x-revelai-athlete-id": value,
    }).success
  );
}

export function getDeviceAthleteId(): string {
  const persisted = window.localStorage.getItem(athleteStorageKey);
  if (isAthleteId(persisted)) return persisted;

  const athleteId = crypto.randomUUID();
  AthleteIdentityHeaderSchema.parse({ "x-revelai-athlete-id": athleteId });
  window.localStorage.setItem(athleteStorageKey, athleteId);
  return athleteId;
}
