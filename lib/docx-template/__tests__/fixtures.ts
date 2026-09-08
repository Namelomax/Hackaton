import type { Protocol } from '@/lib/schemas/protocol-schema';

/**
 * Эталонный протокол для тестов сборки.
 *
 * Поля намеренно «чистые»: cleanProtocolText не должна их менять, иначе круговой
 * тест markdown → Protocol → markdown будет падать не по делу.
 */
export const SAMPLE_PROTOCOL: Protocol = {
  protocolNumber: '№7',
  meetingDate: '12.01.2025',
  protocolTitle: 'Обновление 1С:БГУ',
  contractNumber: '1122435346',
  contractDate: '30.12.2025',
  contractSubject: 'Сопровождение ГИС «Единая централизованная система»',
  agenda: {
    items: ['Версия и дата обновления 1С:БГУ', 'Регламент доступа к тестовому контуру'],
  },
  participants: {
    customer: {
      organizationName: 'ООО «Ромашка»',
      people: [{ fullName: 'Иванов И.И.', position: 'Главный бухгалтер' }],
    },
    executor: {
      organizationName: 'ООО «Форус»',
      people: [
        { fullName: 'Петров П.П.', position: 'Руководитель проекта' },
        { fullName: 'Сидоров С.С.', position: 'Аналитик' },
      ],
    },
  },
  meetingContent: {
    topics: [
      {
        title: 'Принятие решения о версии обновления',
        listened: 'Иванов И.И., Петров П.П.',
        discussed: 'Рассмотрели релиз 2.0.102.79 и окно обновления после 20:00.',
        decided: 'Обновить 1С:БГУ на релиз 2.0.102.79\nСрок: 09.04.2025\nОтветственные: Петров П.П.',
      },
      {
        title: 'Доступ к тестовому контуру',
        listened: 'Сидоров С.С.',
        discussed: 'Обсудили порядок выдачи учётных записей.',
        decided: 'Выдать доступ трём сотрудникам заказчика',
      },
    ],
    summary: [
      {
        question: 'Версия и дата обновления 1С:БГУ',
        decision: 'Обновление на релиз 2.0.102.79\nСрок: 09.04.2025\nОтветственные: Петров П.П.',
      },
    ],
  },
  approval: {
    customer: { organization: 'ООО «Ромашка»', signatories: ['Иванов И.И.'] },
    executor: { organization: 'ООО «Форус»', signatories: ['Петров П.П.', 'Сидоров С.С.'] },
  },
};
