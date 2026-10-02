import { isCloudModeEnabled } from '../deployment-mode';

describe('isCloudModeEnabled', () => {
  it('по умолчанию включён — текущий прод не меняет поведения', () => {
    expect(isCloudModeEnabled({})).toBe(true);
    expect(isCloudModeEnabled({ CLOUD_MODE: '' })).toBe(true);
    expect(isCloudModeEnabled({ CLOUD_MODE: 'on' })).toBe(true);
  });

  it('выключается любым привычным написанием', () => {
    for (const v of ['off', 'OFF', ' false ', '0', 'no']) {
      expect(isCloudModeEnabled({ CLOUD_MODE: v })).toBe(false);
    }
  });
});
