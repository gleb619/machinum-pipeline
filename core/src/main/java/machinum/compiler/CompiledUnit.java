package machinum.compiler;

import lombok.RequiredArgsConstructor;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;

@RequiredArgsConstructor
public class CompiledUnit<T> implements Compiled<T> {

  private final Compiled<T> delegate;

  public static <U> CompiledUnit<U> of(
      Object value, ExpressionContext context, ExpressionResolver resolver) {
    var compiledValue = Compiled.of(value, context, resolver);
    return new CompiledUnit(compiledValue);
  }

  public static <T> CompiledUnit<T> empty() {
    return of(null, null, null);
  }

  @Override
  public T get() {
    return delegate.get();
  }

  @Override
  public int hashCode() {
    return delegate.hashCode();
  }

  @Override
  public boolean equals(Object obj) {
    return delegate.equals(obj);
  }

  @Override
  public String toString() {
    return delegate.toString();
  }
}
