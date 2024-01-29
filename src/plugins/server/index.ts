import { ensureNotFalsy, flatClone } from 'rxdb/plugins/utils';
import { RxServer } from './rx-server.ts';
import { RxServerOptions } from './types.ts';
import express from 'express';
import {
    Server as HttpServer
} from 'http';

export * from './types.ts';
export * from './endpoint-replication.ts';
export * from './endpoint-rest.ts';
export * from './helper.ts';

export async function startRxServer<AuthType>(options: RxServerOptions<AuthType>): Promise<RxServer<AuthType>> {
    options = flatClone(options);
    if (!options.serverApp) {
        const app = express();
        options.serverApp = app;
    }

    options.serverApp.use(express.json());


    const httpServer: HttpServer = await new Promise((res, rej) => {
        const hostname = options.hostname ? options.hostname : 'localhost';
        const ret = ensureNotFalsy(options.serverApp).listen(options.port, hostname, () => {
            res(ret);
        });
    });

    const server = new RxServer<AuthType>(
        options.database,
        options.authHandler,
        httpServer,
        ensureNotFalsy(options.serverApp),
        options.cors
    );

    return server;
}
