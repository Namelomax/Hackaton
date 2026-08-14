import { isGenericEntityValue, dropNonSensitiveEntries } from '../scrub';

/**
 * Слова со скриншота заказчика: NER пометил местоимения и нарицательные как
 * сущности, из-за чего в протоколе появились «организация Мы», «сотрудник
 * девчонки», «сотрудник Кате», «на проекте здесь».
 */
describe('родовые слова из отчёта заказчика', () => {
  const fromCustomerReport = ['Мы', 'девчонки', 'она', 'здесь'];

  it.each(fromCustomerReport)('«%s» — сейчас НЕ распознаётся как родовое слово', (word) => {
    // Фиксируем текущее поведение: стоп-лист их не знает, и они уезжают в
    // маппинг как ORG/PERSON. Тест станет «зелёным наоборот», когда слова
    // добавят в GENERIC_ENTITY_WORDS — тогда ожидание нужно поменять на true.
    expect(isGenericEntityValue(word)).toBe(false);
  });

  it('те, что в списке есть, отсекаются в любом падеже', () => {
    for (const w of ['заказчик', 'Заказчика', 'организацию', 'учреждения', 'сотрудники']) {
      expect(isGenericEntityValue(w)).toBe(true);
    }
  });

  it('настоящие имена и названия не трогаются', () => {
    for (const w of ['Журавлёва Елена Борисовна', 'ООО «Атлант»', 'Калуга']) {
      expect(isGenericEntityValue(w)).toBe(false);
    }
  });

  it('родовое значение выбрасывается из маппинга и возвращается в текст', () => {
    const res = dropNonSensitiveEntries('Встреча с [ORG_1] по проекту', {
      '[ORG_1]': 'организация',
      '[PERSON_1]': 'Журавлёва Елена Борисовна',
    });
    expect(res.text).toBe('Встреча с организация по проекту');
    expect(Object.keys(res.mapping)).toEqual(['[PERSON_1]']);
    expect(res.dropped).toHaveLength(1);
  });
});
