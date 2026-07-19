# Источники заполненных образцов документов по чек-листу

Подборка открытых сайтов с **образцами заполнения** (готовые примеры с вымышленными данными) и пустыми бланками для тестирования анонимайзера. Все ссылки — «образец заполнения / бланк», данные в них фиктивные, поэтому их безопасно использовать как тест-корпус (см. раздел «Как пользоваться» внизу).

> Статус проверки: сайт `anon-blond.vercel.app` на свежем коде уже корректно маскирует договоры ГПХ (ИРНИТУ) и медсправку — все прежние утечки закрыты.

---

## Универсальные хабы (покрывают большинство типов)

Эти сайты дают образцы почти по всем категориям — начинать удобнее с них:

- **Ассистентус** — https://assistentus.ru/forma/ — бланки + образцы (договоры, кадры, первичка, банк) в Word/Excel
- **nalog-nalog.ru** — https://nalog-nalog.ru — образцы налоговых, первичных, договорных документов
- **МойСклад / формы документов** — https://www.moysklad.ru/poleznoe/formy-dokumentov/ — первичка, договоры, накладные
- **КУБ-24** — https://kub-24.ru — бланки первички и договоров с примерами
- **Договор-Юрист.Ру** — https://dogovor-urist.ru — договоры и доверенности (DOC/PDF/RTF/ODT)
- **КонсультантПлюс (образцы)** — https://www.consultant.ru — официальные унифицированные формы
- **ГАРАНТ (примерные формы)** — https://base.garant.ru — примерные формы договоров и судебных документов
- **class365.ru / blanker.ru** — бланки кадровых и медицинских форм

---

## 1. Договорные и гражданско-правовые 🔴

| Тип | Ссылка на образец |
|---|---|
| Договор поставки | [assistentus](https://assistentus.ru/forma/dogovor-na-postavku-tovarov/) · [nalog-nalog](https://nalog-nalog.ru/dogovory/obrazec_tipovogo_dogovora_postavki_tovarov-23/) · [garant (2025)](https://base.garant.ru/1968166/) |
| Договор ГПХ / оказания услуг | есть в твоих тестах (ИРНИТУ, ТехноПрогресс) + [Договор-Юрист](https://dogovor-urist.ru) |
| Доверенность (физлицо) | [assistentus](https://assistentus.ru/forma/doverennost-na-poluchenie-dokumentov/) · [spmag](https://spmag.ru/articles/obrazec-doverennosti-ot-fizicheskogo-lica-fizicheskomu-licu) |
| Акт / спецификация | universal (assistentus, moysklad) |

## 2. Первичные учётные и торговые 🔴

| Тип | Ссылка на образец |
|---|---|
| Счёт-фактура | [assistentus](https://assistentus.ru/forma/schet-faktura/) · [nalog-nalog](https://nalog-nalog.ru/nds/schetfaktura/schet-faktura_na_uslugi_-_obrazec_zapolneniya-23/) · [moysklad](https://www.moysklad.ru/poleznoe/formy-dokumentov/schet-faktura/) |
| УПД | [moysklad](https://www.moysklad.ru/poleznoe/formy-dokumentov/universalnyj-peredatochnyj-dokument/) · [nalog-nalog](https://nalog-nalog.ru/nds/universalnyj_peredatochnyj_dokument_upd/universalnye_peredatochnye_dokumenty-23/) |
| Товарная накладная ТОРГ-12 | [moysklad](https://www.moysklad.ru/poleznoe/formy-dokumentov/torg-12/) · [glavkniga](https://glavkniga.ru/situations/k518670) |

## 3. Кадровые и HR 🔴

| Тип | Ссылка на образец |
|---|---|
| Приказ о приёме (Т-1) | [assistentus](https://assistentus.ru/forma/t-1-prikaz-o-prieme-na-rabotu/) · [class365](https://class365.ru/blanki-dokumentov/prikaz-o-prieme-na-rabotu-obrazets/) · [КонсультантПлюс](https://www.consultant.ru/document/cons_doc_LAW_47274/51afa0a505fe55ab9f3c864c98cc124d851d7bd2/) |
| Справка 2-НДФЛ (о доходах) | [kontur](https://www.kontur-extern.ru/info/zapolnenie-spravki-2-ndfl) · [nalog-nalog](https://nalog-nalog.ru/ndfl/spravka_2ndfl/obrazec-zapolneniya-spravki-2-ndfl/) |
| Приказ о приёме — синтетика | готов: `test_kadровый_prikaz.txt` |

## 4. Финансовые и банковские 🔴

| Тип | Ссылка на образец |
|---|---|
| Платёжное поручение | [assistentus](https://assistentus.ru/forma/platyozhnoe-poruchenie/) · [regberry](https://www.regberry.ru/nalogooblozhenie/kak-zapolnit-platezhnoe-poruchenie) |
| Справка о доходах 2-НДФЛ | см. кадровые выше |

## 5. Медицинские 🔴

| Тип | Ссылка на образец |
|---|---|
| Медсправка 086/у | [blanker](https://blanker.ru/doc/spravka-med-086-u) · [КонсультантПлюс форма](https://www.consultant.ru/document/cons_doc_LAW_175963/999589943642b454003464340e56b0288c788373/) · [medznanie (образец)](https://medznanie.ru/article/o-meditsine/meditsinskaya-spravka-dlya-postupleniya-086-u-obrazets-zapolneniya) |
| Форма 027/у (выписка/справка) | [pharmznanie](https://pharmznanie.ru/gastroznanie/vracham/articles/medicinskaya-forma-027u-obrazec-vidi-i-pravila-oformleniya) |
| Эпикриз — синтетика | готов: `test_medspravka.txt` |

## 8. Юридические и судебные 🔴

| Тип | Ссылка на образец |
|---|---|
| Исковое заявление | [garant (образцы)](https://base.garant.ru/55724388/) · [Договор-Юрист / madroc](https://madroc.ru/obrazcy_iskov.php) |
| Претензия / ходатайство | те же судебные порталы |

## 16. Личные документы физлиц 🔴

| Тип | Где взять |
|---|---|
| Анкета соискателя / резюме | готов: `test_anketa_soiskatelya.txt` (email, @telegram, индекс, загранпаспорт, ИНН) |
| Паспорт/СНИЛС/ИНН — как поля | входят в кадровые и мед. образцы выше |

---

## Как пользоваться

1. Скачай `.docx` / `.xlsx` образец по ссылке (в них уже фиктивные данные — «Иванов И.И.», «ООО Ромашка», примерные ИНН/суммы/даты).
2. Загрузи файл на `anon-blond.vercel.app` → «Обезличить».
3. Сверь по чек-листу: в выводе не должно остаться ФИО, реквизитов, сумм, дат, номеров. Что протекло — фиксируй (тип + формат).
4. Пришли мне протёкший фрагмент — добавлю детектор/правило.

## Что уже покрыто детекторами (проверено)

Договоры/первичка/кадры/медицина по форматам данных закрыты: ФИО (в т.ч. им.падеж с отчеством и «Имя Отчество Фамилия»), ИНН/КПП/ОГРН/ОКПО/ОКВЭД/ОКТМО/ОКАТО, счета/БИК/филиалы, суммы (в т.ч. без валюты), все форматы дат, паспорт/загранпаспорт/СНИЛС/ОМС/ДМС/ВУ, VIN/госномер/кадастровый, email/телефон/@аккаунт/индекс/IP, диагноз-МКБ/история болезни, номера приказов/актов (в т.ч. `№21«А»-О`).

**NER-зона (regex не берёт, добирает GLiNER+LLM на сайте):** наименования организаций без кавычек-формы, улицы/адреса, место рождения, бренды/названия ПО.
