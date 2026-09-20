import { isLikelySameInlineFinding } from '../../../src/github/comment-fingerprint';

describe('isLikelySameInlineFinding', () => {
  it('does not collapse distinct nearby bugs that only share req.query leftovers', () => {
    const skipFooter =
      '\n\n<sub><!-- review-router-skip-help -->A maintainer/admin can reply `/rr skip` if this finding is a false positive. ReviewRouter records a signed override and reruns the check.</sub>';
    expect(
      isLikelySameInlineFinding(
        {
          path: 'payments.js',
          line: 7,
          body:
            [
              '_🔴 Critical_',
              '',
              '**Параметр запроса выполняется как JavaScript**',
              '',
              '`eval(req.query.callback)` выполняет полностью контролируемую клиентом строку в процессе приложения. Любой вызывающий `charge` может исполнить произвольный JavaScript с правами сервера. Удалите выполнение callback-кода.',
            ].join('\n') + skipFooter,
        },
        {
          path: 'payments.js',
          line: 17,
          body:
            [
              '_🔴 Critical_',
              '',
              '**Идентификатор заказа допускает SQL-инъекцию**',
              '',
              '`req.query.id` напрямую вставляется в SQL-строку, поэтому специально сформированный идентификатор может изменить условие запроса. Передавайте идентификатор отдельным параметром подготовленного запроса.',
            ].join('\n') + skipFooter,
        }
      )
    ).toBe(false);
  });

  it('still treats the same English finding as a duplicate after a small line shift', () => {
    expect(
      isLikelySameInlineFinding(
        {
          path: 'src/users.js',
          line: 10,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        },
        {
          path: 'src/users.js',
          line: 9,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        }
      )
    ).toBe(true);
  });
});
