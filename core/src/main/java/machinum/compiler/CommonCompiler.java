package machinum.compiler;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper
public interface CommonCompiler {

  CommonCompiler INSTANCE = Mappers.getMapper(CommonCompiler.class);
  Pattern DURATION_PATTERN = Pattern.compile("(\\d+)\\s*(d|h|m|s|ms)");

  @Named("createExpressionContext")
  default ExpressionContext createExpressionContext(@Context CompilationContext ctx) {
    return ExpressionContext.builder()
        .variables(ctx.variables())
        .env(ctx.environment())
        .runId(ctx.runId())
        .scripts(ctx.scriptRegistry())
        .build();
  }

  @Named("compile")
  default <T> Compiled<T> compile(T value, @Context CompilationContext ctx) {
    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();
    return Compiled.of(value, context, resolver);
  }

  @Named("compileString")
  default Compiled<String> compileString(String raw, @Context CompilationContext ctx) {
    return compile(raw, ctx);
  }

  @Named("simpleMap")
  default Map<String, String> simpleMap(Map<String, String> source) {
    Map<String, String> map = Objects.requireNonNullElse(source, Collections.emptyMap());
    return new HashMap<>(map);
  }

  @Named("compileMap")
  default CompiledMap<String> compileMap(
      Map<String, String> source, @Context CompilationContext ctx) {
    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();
    var map = simpleMap(source);
    return CompiledMap.of(map, context, resolver);
  }

  @Named("compileObjectMap")
  default CompiledMap<Object> compileObjectMap(
      Map<String, Object> source, @Context CompilationContext ctx) {
    if (source == null) return CompiledMap.empty();

    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();
    var map = new HashMap<>(source);
    return CompiledMap.of(map, context, resolver);
  }

  @Named("compileList")
  default CompiledList<Object> compileList(List<Object> source, @Context CompilationContext ctx) {
    if (source == null) return CompiledList.empty();

    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();
    var list = new ArrayList<>(source);
    return CompiledList.of(list, context, resolver);
  }

  @Named("compileObject")
  default <T> CompiledUnit<T> compileObject(T source, @Context CompilationContext ctx) {
    if (source == null) return CompiledUnit.empty();

    ExpressionContext context = createExpressionContext(ctx);
    ExpressionResolver resolver = ctx.resolver();
    return CompiledUnit.of(source, context, resolver);
  }

  @Named("compileDuration")
  default Compiled<Duration> compileDuration(String source) {
    if (source == null || source.isBlank()) {
      return CompiledConstant.of(Duration.ZERO);
    }

    var src = source.trim().toLowerCase();
    long total = 0;
    Matcher m = DURATION_PATTERN.matcher(src);
    boolean found = false;
    while (m.find()) {
      found = true;
      long v = Long.parseLong(m.group(1));
      total += switch (m.group(2)) {
        case "d" -> v * 86_400_000L;
        case "h" -> v * 3_600_000L;
        case "m" -> v * 60_000L;
        case "s" -> v * 1_000L;
        case "ms" -> v;
        default -> throw new IllegalArgumentException("Unknown unit");
      };
    }
    if (!found) return CompiledConstant.of(Duration.parse(source.toUpperCase()));
    return CompiledConstant.of(Duration.ofMillis(total));
  }
}
