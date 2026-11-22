declare module 'pg' {
    export interface ClientConfig {
        host?: string;
        port?: number;
        user?: string;
        password?: string;
        database?: string;
    }

    export interface QueryResultRow {
        [column: string]: unknown;
    }

    export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
        rows: R[];
    }

    export class Client {
        constructor(config?: ClientConfig);
        connect(): Promise<void>;
        end(): Promise<void>;
        query<R extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: unknown[],
        ): Promise<QueryResult<R>>;
    }

    const pg: { Client: typeof Client };
    export default pg;
    export { Client, ClientConfig, QueryResult, QueryResultRow };
}
