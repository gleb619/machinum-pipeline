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

@Slf4j
@RequiredArgsConstructor
public class DefaultExpressionResolver implements ExpressionResolver {

  private static final Pattern EXPRESSION_PATTERN = Pattern.compile("\\{\\{([^}]+)\\}\\}");

  @Deprecated(forRemoval = true)
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

  private Object resolveExpression(String expression, ExpressionContext context) {
    if (expression.startsWith("scripts.")) {
      return resolveScriptExpression(expression, context);
    }

    try {
      var binding = new Binding();
      populateBinding(binding, context);

      CompilerConfiguration config = new CompilerConfiguration();
      GroovyShell shell = new GroovyShell(binding, config);

      return shell.evaluate(expression);
    } catch (Exception e) {
      log.error("Failed to resolve expression: {}", expression, e);
      throw new RuntimeException("Expression resolution failed for: " + expression, e);
    }
  }

  private Object resolveScriptExpression(String expression, ExpressionContext context) {
    ScriptRegistry scripts = context.getScripts();
    if (scripts == null) {
      throw new RuntimeException(
          "Script registry is null. Cannot execute script expression: " + expression);
    }

    try {
      String dottedPath = expression.substring(8);
      String[] parts = dottedPath.split("\\.", 2);
      if (parts.length != 2) {
        throw new IllegalArgumentException("Invalid script expression format: " + expression
            + ". Expected: scripts.<type>.<name>(args)");
      }

      String scriptType = parts[0];
      String scriptNameAndArgs = parts[1];

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

      ScriptRegistry.ScriptType type = ScriptRegistry.ScriptType.fromDirectoryName(scriptType);
      if (type == null) {
        String[] elements = Arrays.stream(ScriptType.values())
            .map(ScriptType::getDirectoryName)
            .toArray(String[]::new);
        throw new IllegalArgumentException("Invalid script type: %s. Valid types: %s"
            .formatted(scriptType, String.join(", ", elements)));
      }

      Path scriptPath = scripts.getScript(type, scriptName);

      var binding = new Binding();
      populateBinding(binding, context);

      if (argExpressions != null && argExpressions.length > 0) {
        Object[] args = new Object[argExpressions.length];
        for (int i = 0; i < argExpressions.length; i++) {
          String argExpr = argExpressions[i].trim();
          args[i] = resolveExpression(argExpr, context);
        }
        binding.setVariable("args", args);
        if (args.length > 0) {
          binding.setVariable("arg", args[0]);
        }
      }

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

  private void populateBinding(Binding binding, ExpressionContext context) {
    binding.setVariable("item", context.getItem());
    binding.setVariable("text", context.getText());
    binding.setVariable("index", context.getIndex());
    binding.setVariable("textLength", context.getTextLength());
    binding.setVariable("textWords", context.getTextWords());
    binding.setVariable("textTokens", context.getTextTokens());
    binding.setVariable("aggregationIndex", context.getAggregationIndex());
    binding.setVariable("aggregationText", context.getAggregationText());
    binding.setVariable("runId", context.getRunId());

    // TODO: Rewrite class

    binding.setVariable("retryAttempt", context.getRetryAttempt());

    binding.setVariable("env", context.getEnv());

    context.getVariables().forEach(binding::setVariable);
    binding.setVariable("variables", context.getVariables());

    binding.setVariable("scripts", context.getScripts());
  }
}
