import { checkArgument, checkState, IllegalStateError, InvalidArgumentError } from ".";

describe('errors', () => {
  it('checkArgument should throw InvalidArgumentError if condition false', async () => {
    expect(() => checkArgument(false, "foo")).toThrow(InvalidArgumentError);
  });
  it('checkArgument should not throw if condition true', async () => {
    expect(() => checkArgument(true, "foo")).not.toThrow();
  });
  it('checkState should throw IllegalStateError if condition false', async () => {
    expect(() => checkState(false, "foo")).toThrow(IllegalStateError);
  });
  it('checkState should not throw if condition true', async () => {
    expect(() => checkState(true, "foo")).not.toThrow();
  });
});
