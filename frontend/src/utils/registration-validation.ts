// Keep these rules aligned with backend RegisterDto. Confirmation is a UI typing
// safeguard; only the original, unmodified password is sent to the server.
export function normalizeRegistrationPhone(value: string): string | undefined {
  return value.trim() || undefined;
}

export function registrationPhoneError(value: string): string | undefined {
  const phone = normalizeRegistrationPhone(value);
  return phone && !/^1[3-9]\d{9}$/.test(phone) ? '请输入11位中国大陆手机号' : undefined;
}

export function registrationPasswordError(value: string): string | undefined {
  if (!value) return '请输入密码';
  // class-validator MinLength counts Unicode code points, not UTF-16 code units.
  if ([...value].length < 6) return '密码至少6个字符';
  if (new TextEncoder().encode(value).length > 72) return '密码不能超过72字节（中文及表情会占多个字节）';
  return undefined;
}
