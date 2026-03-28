package machinum.compiler;

import java.util.HashMap;
import java.util.Map;
import lombok.Builder;
import lombok.Value;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;

@Value
@Builder
// TODO: redo class to record
public class CompilationContext {

  ExpressionResolver resolver;

  ScriptRegistry scriptRegistry;

  Map<String, Object> variables = new HashMap<>();

  Map<String, String> environment = new HashMap<>();

  // TODO: Remove extra, it's a runtime info, that can't acquired at compile time
  @Deprecated(forRemoval = true)
  String runId;
}
