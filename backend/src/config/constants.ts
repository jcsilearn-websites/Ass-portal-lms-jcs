export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const JWT_TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;

export type JwtTokenType = (typeof JWT_TOKEN_TYPE)[keyof typeof JWT_TOKEN_TYPE];

export const REFRESH_TOKEN_COOKIE_NAME = '__session';
