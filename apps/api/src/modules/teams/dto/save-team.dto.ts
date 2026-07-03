export class SaveTeamDto {
  id?: string;
  name?: string;
  description?: string;
  providerId?: string | null;
  language?: string;
  budget?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  run?: Record<string, unknown>;
  testing?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}
