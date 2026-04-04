package machinum.compiler;

import java.util.Objects;
import lombok.Builder;

@Builder
public record CompiledConstant<T>(T constant) implements Compiled<T> {

  public static <U> CompiledConstant<U> of(U raw) {
    return CompiledConstant.<U>builder().constant(raw).build();
  }

  @Override
  public T get() {
    return constant;
  }

  @Override
  public String toString() {
    return Objects.toString(constant);
  }
}
