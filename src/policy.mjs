import { exactKeys } from './values.mjs';

const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function validatePolicy(value) {
  if (!exactKeys(value, ['timeZone', 'quietStart', 'quietEnd', 'stateDirectory'])
    || typeof value.timeZone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value.timeZone)
    || typeof value.stateDirectory !== 'string' || !value.stateDirectory.trim()
    || ![value.quietStart, value.quietEnd].every((time) => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    || value.quietStart === value.quietEnd) throw new Error('Config needs a named timeZone, different HH:MM quietStart/quietEnd, and stateDirectory.');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
      timeZone: value.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    });
  } catch { throw new Error('This Node runtime does not support the configured timeZone.'); }
  return { ...value, timeZone: formatter.resolvedOptions().timeZone };
}

export function quietNow(policy, now) {
  if (!Number.isFinite(now)) throw new Error('Clock must return a valid epoch time.');
  const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
    timeZone: policy.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const start = minute(policy.quietStart);
  const end = minute(policy.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}
