export function fixtureError(): AggregateError {
  return Object.assign(
    new AggregateError([new TypeError('nested'), { reason: 'plain' }], 'rich', {
      cause: new RangeError('cause'),
    }),
    { code: 'E_RICH' },
  );
}

export function checkFixtureError(error: unknown): void {
  if (
    !(error instanceof AggregateError) ||
    !(error.cause instanceof RangeError) ||
    !('code' in error) ||
    error.code !== 'E_RICH' ||
    !(error.errors[0] instanceof TypeError) ||
    JSON.stringify(error.errors[1]) !== '{"reason":"plain"}'
  ) {
    throw new Error('Rich error did not survive Electron transport');
  }
}
