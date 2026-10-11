# Этап 3А. Проверка приватного ответа GAS

Второй этап уже показал, что публичные вопросы можно получать по GET JSONP, а запросы отправлять через no-cors POST.

**Проблема**: Google предупреждает, что JSONP подходит только для открытой несекретной информации. Индивидуальные баллы и объяснения пока не следует передавать через публичный JSONP.

Поэтому исследуем связку: Github Pages → скрытый GAS HtmlService iframe → `google.script.run` → `window.top.postMessage` с проверкой origin.

## Как тестировать
1. В НОВОМ проекте «Вычитать — Mini App» (НЕ в старом боте) заменить `Code.gs` на `Stage3-PrivateBridge.gs`.
2. Deploy → Manage deployments → Edit → New version → Deploy.
3. Открыть с Github Pages страницу `private-bridge-test.html`.
4. Вставить прежний URL GAS `/exec` и нажать кнопку проверки.

Никаких Script Properties добавлять не нужно; это тест только обмена сообщениями.

**Если тест не проходит**, текущая реализация является лишь экспериментом. Не вводить токены и не публиковать настоящий тест. Мы подберём другую безопасную архитектуру.

## Безопасность
Этот этап не использует данные Telegram, не читает/пишет Google Sheets и не создаёт ответы. Исполнитель GAS работает от имени владельца, а iframe через HtmlService разрешён для встраивания. Для продакшена потребуются проверка Telegram initData HMAC, ограничения сессий и origin, блокировка повторного ответа, безопасная обработка сообщений.

Официальные ссылки:
- https://developers.google.com/apps-script/guides/html/communication
- https://developers.google.com/apps-script/guides/content
- https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
