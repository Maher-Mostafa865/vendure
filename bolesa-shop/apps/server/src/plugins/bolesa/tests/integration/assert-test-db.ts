/** Hard-coded isolated test database. Never change without updating safety docs. */
export const REQUIRED_TEST_DB = 'vendure-bolesa-test';

/** Databases that must never be targeted by integration tests or migrations from this harness. */
export const FORBIDDEN_DATABASES = new Set(['vendure-dev', 'postgres', 'template0', 'template1']);

export function assertTestDatabaseName(name: string | undefined | null): asserts name is string {
    if (!name || name !== REQUIRED_TEST_DB) {
        throw new Error(
            `SAFETY ABORT: resolved database name is ${JSON.stringify(name)}; ` +
                `expected exactly ${JSON.stringify(REQUIRED_TEST_DB)}. ` +
                `Refusing to continue (would risk vendure-dev or another DB).`,
        );
    }
    if (FORBIDDEN_DATABASES.has(name)) {
        throw new Error(`SAFETY ABORT: database ${name} is forbidden for Bolesa integration tests.`);
    }
}
