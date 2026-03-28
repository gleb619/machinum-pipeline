package machinum.pipeline;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.any;
import static org.mockito.Mockito.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import machinum.expression.ExpressionContext;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineStateManifest;
import machinum.manifest.ToolManifestDepricated;
import org.assertj.core.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class EnhancedExecutionContextTest {

  @Mock
  private ExpressionResolver expressionResolver;

  @Mock
  private ScriptRegistry scriptRegistry;

  private PipelineStateManifest stateManifest;

  private ToolManifestDepricated toolManifest;

  private EnhancedExecutionContext context;

  @BeforeEach
  void setUp() {
    Map<String, Object> metadata = new HashMap<>();
    metadata.put("pipeline", "test-pipeline");

    Map<String, Object> variables = new HashMap<>();
    variables.put("book_name", "Test Book");

    Map<String, String> environment = new HashMap<>();
    environment.put("API_KEY", "test-key");

    stateManifest = PipelineStateManifest.builder().build();
    toolManifest = ToolManifestDepricated.builder().build();

    context = EnhancedExecutionContext.builder()
        .runId("run-001")
        .metadata(metadata)
        .variables(variables)
        .environment(environment)
        .expressionResolver(expressionResolver)
        .scriptRegistry(scriptRegistry)
        .build();
  }

  @Test
  void testEvaluateWithoutExpressionResolver() {
    EnhancedExecutionContext contextWithoutResolver = EnhancedExecutionContext.builder()
        .runId("run-001")
        .variables(new HashMap<>())
        .environment(new HashMap<>())
        .build();

    Object result = contextWithoutResolver.evaluate("plain text");
    assertEquals("plain text", result);
  }

  @Test
  void testHasExpressions() {
    when(expressionResolver.supportsInlineExpression("{{item.id}}")).thenReturn(true);
    when(expressionResolver.supportsInlineExpression("plain text")).thenReturn(false);

    assertTrue(context.hasExpressions("{{item.id}}"));
    assertFalse(context.hasExpressions("plain text"));

    EnhancedExecutionContext contextWithoutResolver =
        EnhancedExecutionContext.builder().runId("run-001").build();

    assertFalse(contextWithoutResolver.hasExpressions("{{item.id}}"));
  }

  @Test
  void testGetVariableWithoutExpression() {
    Optional<Object> result = context.getVariable("book_name");

    Assertions.assertThat(result).hasValue("Test Book");
  }

  @Test
  void testGetVariableWithExpression() {
    Map<String, Object> variables = new HashMap<>();
    variables.put("title", "{{item.id}} - {{item.type}}");

    EnhancedExecutionContext contextWithExpression = EnhancedExecutionContext.builder()
        .runId("run-001")
        .variables(variables)
        .expressionResolver(expressionResolver)
        .build();

    Map<String, Object> item = new HashMap<>();
    item.put("id", "123");
    item.put("type", "chapter");

    contextWithExpression.updateItem(item, 0);

    when(expressionResolver.supportsInlineExpression("{{item.id}} - {{item.type}}"))
        .thenReturn(true);
    when(expressionResolver.resolveTemplate(eq("{{item.id}} - {{item.type}}"), any()))
        .thenReturn("123 - chapter");

    Optional<Object> result = contextWithExpression.getVariable("title");
    Assertions.assertThat(result).hasValue("123 - chapter");
  }

  @Test
  void testGetEnvironment() {
    Optional<String> result = context.getEnvironment("API_KEY");
    Assertions.assertThat(result).hasValue("test-key");

    assertTrue(context.getEnvironment("NON_EXISTENT").isEmpty());
  }

  @Test
  void testSetVariable() {
    context.setVariable("new_var", "new_value");
    assertEquals("new_value", context.getVariable("new_var").get());
  }

  @Test
  void testUpdateItem() {
    Map<String, Object> item = new HashMap<>();
    item.put("id", "123");

    context.updateItem(item, 5);

    assertEquals(item, context.getCurrentItem());
    assertEquals(5, context.getCurrentIndex());
  }

  @Test
  void testUpdateRetryAttempt() {
    context.updateRetryAttempt(3);
    assertEquals(3, context.getRetryAttempt());
  }

  @Test
  void testUpdateAggregation() {
    context.updateAggregation(2, "batch text");
    assertEquals(2, context.getAggregationIndex());
    assertEquals("batch text", context.getAggregationText());
  }

  @Test
  void testGetTextContent() {
    Map<String, Object> item = new HashMap<>();
    item.put("content", "Test content");
    item.put("other", "value");

    context.updateItem(item, 0);

    when(expressionResolver.resolveTemplate(any(), any())).thenReturn("resolved");

    Object result = context.evaluate("{{text}}");

    verify(expressionResolver).resolveTemplate(eq("{{text}}"), any());
  }

  @Test
  void testCreateChildContext() {
    Map<String, Object> originalVariables = new HashMap<>();
    originalVariables.put("parent", "value");

    EnhancedExecutionContext originalContext = EnhancedExecutionContext.builder()
        .runId("run-001")
        .variables(originalVariables)
        .environment(new HashMap<>())
        .expressionResolver(expressionResolver)
        .build();

    EnhancedExecutionContext childContext = originalContext.createChildContext();

    assertEquals(originalContext.getRunId(), childContext.getRunId());
    assertEquals(originalContext.getExpressionResolver(), childContext.getExpressionResolver());

    assertNotSame(originalContext.getVariables(), childContext.getVariables());
    assertEquals(originalContext.getVariables(), childContext.getVariables());
  }

  @Test
  void testTextMetricsCalculation() {
    Map<String, Object> item = new HashMap<>();
    item.put("content", "This is a test sentence with multiple words.");

    context.updateItem(item, 0);

    when(expressionResolver.resolveTemplate(any(), any())).thenAnswer(invocation -> {
      String template = invocation.getArgument(0);
      var exprContext = invocation.getArgument(1);

      if (template.contains("textLength")) {
        return String.valueOf(((ExpressionContext) exprContext).getTextLength());
      }
      if (template.contains("textWords")) {
        return String.valueOf(((ExpressionContext) exprContext).getTextWords());
      }
      if (template.contains("textTokens")) {
        return String.valueOf(((ExpressionContext) exprContext).getTextTokens());
      }
      return "resolved";
    });

    Object lengthResult = context.evaluate("{{textLength}}");
    Object wordsResult = context.evaluate("{{textWords}}");
    Object tokensResult = context.evaluate("{{textTokens}}");

    assertEquals("44", lengthResult);
    assertEquals("8", wordsResult);
    assertTrue(tokensResult.toString().matches("\\d+"));
  }

  @Test
  void testBuilderDefaults() {
    EnhancedExecutionContext minimalContext =
        EnhancedExecutionContext.builder().runId("test").build();

    assertEquals("test", minimalContext.getRunId());
    assertNull(minimalContext.getExpressionResolver());
    assertNull(minimalContext.getScriptRegistry());
    assertNull(minimalContext.getCurrentItem());
    assertNull(minimalContext.getCurrentState());
    assertNull(minimalContext.getCurrentTool());
    assertEquals(0, minimalContext.getCurrentIndex());
    assertEquals(0, minimalContext.getRetryAttempt());
    assertEquals(0, minimalContext.getAggregationIndex());
    assertNull(minimalContext.getAggregationText());
  }
}
