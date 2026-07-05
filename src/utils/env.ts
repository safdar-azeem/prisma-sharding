export const parseBooleanEnv = (
  name: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

export const parsePositiveIntegerEnv = (
  name: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env
): number => {
  const value = env[name]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
};

export const isVerboseEnv = (
  names: string[],
  env: NodeJS.ProcessEnv = process.env
): boolean => names.some((name) => parseBooleanEnv(name, false, env));
