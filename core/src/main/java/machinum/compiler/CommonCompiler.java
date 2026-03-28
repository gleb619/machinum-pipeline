package machinum.compiler;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper
public interface CommonCompiler {

  CommonCompiler INSTANCE = Mappers.getMapper(CommonCompiler.class);

  @Named("createExpressionContext")
  default ExpressionContext createExpressionContext(@Context CompilationContext ctx) {
    return ExpressionContext.builder()
        .variables(ctx.getVariables())
        .env(ctx.getEnvironment())
        .runId(ctx.getRunId())
        .scripts(ctx.getScriptRegistry())
        .build();
  }

  @Named("compileConstant")
  default <T> Compiled<T> compileConstant(T value) {
    return CompiledConstant.of(value);
  }

  @Named("compileString")
  default Compiled<String> compileString(String raw, @Context CompilationContext ctx) {
    if (raw == null) {
      return compileConstant(null);
    }
    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.getResolver();
    return Compiled.of(raw, context, resolver);
  }

  @Named("compileSimpleMap")
  default Map<String, Object> compileSimpleMap(Map<String, String> source) {
    Map<String, String> map = Objects.requireNonNullElse(source, Collections.emptyMap());
    return new HashMap<>(map);
  }

  @Named("compileMap")
  default CompiledMap compileMap(Map<String, String> source, @Context CompilationContext ctx) {
    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.getResolver();
    var map = compileSimpleMap(source);
    return CompiledMap.of(map, context, resolver);
  }
}
