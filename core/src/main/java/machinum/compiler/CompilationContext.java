package machinum.compiler;

import java.nio.file.Path;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;

@Builder
public record CompilationContext(
    ExpressionResolver resolver,

    ScriptRegistry scriptRegistry,

    @Singular Map<String, Object> variables,

    @Singular("env") Map<String, String> environment,

    Path workspaceDir,

    // TODO: Remove extra, it's a runtime info, that can't acquired at compile time
    @Deprecated(forRemoval = true) String runId) {}
