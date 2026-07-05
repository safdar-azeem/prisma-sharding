const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const maskDatabaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url.replace(/:[^:@]+@/, ':***@');
  }
};

export const sanitizeDatabaseText = (output: string, databaseUrls: string[]): string => {
  let sanitized = output;

  for (const url of databaseUrls) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(url), 'g'), maskDatabaseUrl(url));
    try {
      const password = new URL(url).password;
      if (password.length >= 4) {
        sanitized = sanitized.replace(
          new RegExp(escapeRegExp(decodeURIComponent(password)), 'g'),
          '***'
        );
      }
    } catch {
      // The general URL credential pattern below still handles malformed URL-like values.
    }
  }

  return sanitized.replace(
    /(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi,
    '$1***$2'
  );
};
