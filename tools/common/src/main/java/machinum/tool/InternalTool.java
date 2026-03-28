package machinum.tool;

import machinum.Tool;
import machinum.pipeline.ExecutionContext;

/**
 * Base interface for internal Java tools.
 *
 * <p>Internal tools are implemented in Java and run within the same JVM as the pipeline engine.
 * They implement this interface to provide processing logic.
 */
public interface InternalTool extends Tool {

  /**
   * Process the execution context and return the result.
   *
   * <p>This method is called by the default {@link #execute(ExecutionContext)} implementation.
   * Subclasses should override this method instead of {@code execute()}.
   *
   * @param context the execution context containing input and variables
   * @return the tool execution result
   * @throws Exception if processing fails
   */
  ToolResult process(ExecutionContext context) throws Exception;

  @Override
  default ToolResult execute(ExecutionContext context) throws Exception {
    return process(context);
  }
}
