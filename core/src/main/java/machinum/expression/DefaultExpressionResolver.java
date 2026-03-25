package machinum.expression;

import groovy.lang.Binding;
import groovy.lang.GroovyShell;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.script.ScriptEngineManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.expression.ScriptRegistry.ScriptType;
import org.codehaus.groovy.control.CompilerConfiguration;

/**
 * Default implementation of ExpressionResolver that supports template expressions with {{...}}
 * syntax. Integrates with Groovy scripting engine for complex expressions and script-based
 * conditions/transformers/validators.
 */
@Slf4j
@RequiredArgsConstructor
public class DefaultExpressionResolver implements ExpressionResolver {

  private static final Pattern EXPRESSION_PATTERN = Pattern.compile("\\{\\{([^}]+)\\}\\}");
  //TODO: Unused
  @Deprecated(forRemoval = true)
  private static final Pattern SCRIPT_EXPRESSION_PATTERN =
      Pattern.compile("^scripts\\.(\\w+)\\.(\\w+)(?:\\((.*)\\))?$");
  private final ScriptEngineManager engineManager;

  @Override
  public Object resolveTemplate(String template, ExpressionContext context) {
    if (template == null || template.trim().isEmpty()) {
      return template;
    }

    if (!supportsInlineExpression(template)) {
      return template;
    }

    Matcher matcher = EXPRESSION_PATTERN.matcher(template);
    StringBuilder result = new StringBuilder();

    while (matcher.find()) {
      String expression = matcher.group(1).trim();
      Object resolvedValue = resolveExpression(expression, context);
      matcher.appendReplacement(result, Matcher.quoteReplacement(String.valueOf(resolvedValue)));
    }

    matcher.appendTail(result);
    return result.toString();
  }

  @Override
  public boolean supportsInlineExpression(String value) {
    return value != null && EXPRESSION_PATTERN.matcher(value).find();
  }

  /**
   * Resolves a single expression (without the {{ }} delimiters).
   *
   * @param expression the expression to resolve
   * @param context the expression context
   * @return the resolved value
   */
  private Object resolveExpression(String expression, ExpressionContext context) {
    // Check for script-based expression first (e.g., scripts.conditions.should_clean(item))
    if (expression.startsWith("scripts.")) {
      return resolveScriptExpression(expression, context);
    }

    try {
      // Create Groovy binding with all context variables
      var binding = new Binding();
      populateBinding(binding, context);

      // Create a new Groovy engine with the binding
      CompilerConfiguration config = new CompilerConfiguration();
      GroovyShell shell = new GroovyShell(binding, config);

      return shell.evaluate(expression);

    } catch (Exception e) {
      log.error("Failed to resolve expression: {}", expression, e);
      throw new RuntimeException("Expression resolution failed for: " + expression, e);
    }
  }

  /**
   * Resolves script-based expressions like scripts.conditions.should_clean(item).
   *
   * @param expression the script expression
   * @param context the expression context
   * @return the script execution result
   */
  private Object resolveScriptExpression(String expression, ExpressionContext context) {
    ScriptRegistry scripts = context.getScripts();
    if (scripts == null) {
      throw new RuntimeException(
          "Script registry is null. Cannot execute script expression: " + expression);
    }

    try {
      // Parse expression: scripts.<type>.<name>(args)
      String dottedPath = expression.substring(8); // Remove "scripts."
      String[] parts = dottedPath.split("\\.", 2);
      if (parts.length != 2) {
        throw new IllegalArgumentException("Invalid script expression format: " + expression
            + ". Expected: scripts.<type>.<name>(args)");
      }

      String scriptType = parts[0];
      String scriptNameAndArgs = parts[1];

      // Extract script name and arguments
      String scriptName;
      String[] argExpressions = null;

      int parenStart = scriptNameAndArgs.indexOf('(');
      if (parenStart != -1) {
        scriptName = scriptNameAndArgs.substring(0, parenStart);
        int parenEnd = scriptNameAndArgs.lastIndexOf(')');
        if (parenEnd == -1) {
          throw new IllegalArgumentException(
              "Missing closing parenthesis in script expression: " + expression);
        }
        String argsContent = scriptNameAndArgs.substring(parenStart + 1, parenEnd);
        if (!argsContent.isBlank()) {
          argExpressions = argsContent.split(",");
        }
      } else {
        scriptName = scriptNameAndArgs;
      }

      // Resolve script type
      ScriptRegistry.ScriptType type = ScriptRegistry.ScriptType.fromDirectoryName(scriptType);
      if (type == null) {
        String[] elements = Arrays.stream(ScriptType.values())
            .map(ScriptType::getDirectoryName)
            .toArray(String[]::new);
        throw new IllegalArgumentException(
            "Invalid script type: %s. Valid types: %s".formatted(
                scriptType, String.join(", ", elements)));
      }

      // Get script path
      Path scriptPath = scripts.getScript(type, scriptName);

      // Create binding with context variables
      var binding = new Binding();
      populateBinding(binding, context);

      // Add arguments if provided
      if (argExpressions != null && argExpressions.length > 0) {
        // Evaluate argument expressions first
        Object[] args = new Object[argExpressions.length];
        for (int i = 0; i < argExpressions.length; i++) {
          String argExpr = argExpressions[i].trim();
          args[i] = resolveExpression(argExpr, context);
        }
        binding.setVariable("args", args);
        // Common convention: first arg is often 'item' or 'text'
        if (args.length > 0) {
          binding.setVariable("arg", args[0]);
        }
      }

      // Load and execute script
      String scriptContent = scripts.loadScript(scriptPath);
      CompilerConfiguration config = new CompilerConfiguration();
      GroovyShell shell = new GroovyShell(binding, config);

      log.debug("Executing script: {}.{}, path: {}", scriptType, scriptName, scriptPath);
      return shell.evaluate(scriptContent);

    } catch (IOException e) {
      log.error("Failed to load script for expression: {}", expression, e);
      throw new RuntimeException("Failed to load script: " + expression, e);
    } catch (Exception e) {
      log.error("Failed to execute script: {}", expression, e);
      throw new RuntimeException("Failed to execute script: " + expression, e);
    }
  }

  /**
   * Populates a Groovy Binding with all context variables.
   *
   * @param binding the binding to populate
   * @param context the expression context
   */
  private void populateBinding(Binding binding, ExpressionContext context) {
    // Core context variables
    binding.setVariable("item", context.getItem());
    binding.setVariable("text", context.getText());
    binding.setVariable("index", context.getIndex());
    binding.setVariable("textLength", context.getTextLength());
    binding.setVariable("textWords", context.getTextWords());
    binding.setVariable("textTokens", context.getTextTokens());
    binding.setVariable("aggregationIndex", context.getAggregationIndex());
    binding.setVariable("aggregationText", context.getAggregationText());
    binding.setVariable("runId", context.getRunId());
    binding.setVariable("state", context.getState());
    binding.setVariable("tool", context.getTool());
    binding.setVariable("retryAttempt", context.getRetryAttempt());

    // Environment variables with env. prefix access
    binding.setVariable("env", context.getEnv());

    // Pipeline variables (both direct access and via 'variables' map)
    context.getVariables().forEach(binding::setVariable);
    binding.setVariable("variables", context.getVariables());

    // Script registry
    binding.setVariable("scripts", context.getScripts());
  }
}
