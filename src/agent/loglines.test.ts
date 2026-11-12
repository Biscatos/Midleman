import { expect, test } from 'bun:test';
import { pickLogLines } from './loglines';

const PATTERN = /ERROR|Exception|FATAL|panic/i;
const LOG = `warn: Microsoft.AspNetCore.Server.Kestrel[22]
      As of "10/27/2026 13:31:25 +00:00", the heartbeat has been running for "00:00:02.6" which is longer than "00:00:01".
warn: MassTransit[0]
      Connection Failed: rabbitmq://10.11.1.200/
      RabbitMQ.Client.Exceptions.BrokerUnreachableException: None of the specified endpoints were reachable
       ---> System.Net.Sockets.SocketException (111): Connection refused
         at System.Net.Sockets.Socket.AwaitableSocketAsyncEventArgs.ThrowException(SocketError error)
         --- End of inner exception stack trace ---
info: Microsoft.Hosting.Lifetime[0]
      Application started.
fail: App.Worker[0]
      Could not save the order
2026-10-27 WARN pool almost full`.split('\n');

test('.NET warnings are joined with their message and kept as warnings', () => {
    const got = pickLogLines(LOG, PATTERN, null);
    expect(got.map(x => [x.warn, x.line.slice(0, 44)])).toEqual([
        [true, 'warn: Microsoft.AspNetCore.Server.Kestrel[22'],
        [true, 'warn: MassTransit[0] Connection Failed: rabb'],
        [false, '      RabbitMQ.Client.Exceptions.BrokerUnrea'],
        [false, '       ---> System.Net.Sockets.SocketExcepti'],
        [false, 'fail: App.Worker[0] Could not save the order'],
        [true, '2026-10-27 WARN pool almost full'],
    ]);
    expect(got[0].line).toContain('heartbeat has been running');
    expect(got[1].i).toBe(2);
});

test('LOG_IGNORE drops a joined warning', () => {
    expect(pickLogLines(LOG, PATTERN, /heartbeat/i).some(x => x.line.includes('Kestrel'))).toBe(false);
});
