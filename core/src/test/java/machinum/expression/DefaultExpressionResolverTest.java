package machinum.expression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import javax.script.ScriptEngineManager;
import machinum.yaml.StateDefinition;
import machinum.yaml.ToolDefinition;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Unit tests for DefaultExpressionResolver. */
class DefaultExpressionResolverTest {

  private DefaultExpressionResolver resolver;

  @BeforeEach
  void setUp() {
    resolver = new DefaultExpressionResolver(new ScriptEngineManager());
  }

  @Test
  void testSupportsInlineExpression() {
    assertTrue(resolver.supportsInlineExpression("Hello {{name}}!"));
    assertTrue(resolver.supportsInlineExpression("{{item.id}}"));
    assertFalse(resolver.supportsInlineExpression("plain text"));
    assertFalse(resolver.supportsInlineExpression(null));
    assertFalse(resolver.supportsInlineExpression(""));
  }

  @Test
  void testResolveSimpleTemplate() {
    Map<String, Object> item = new HashMap<>();
    item.put("id", "test-123");
    item.put("content", "Hello World");

    ExpressionContext context = ExpressionContext.builder()
        .item(item)
        .text("Hello World")
        .index(0)
        .runId("run-001")
        .build();

    Object result = resolver.resolveTemplate("Item {{item.id}}: {{text}}", context);
    assertEquals("Item test-123: Hello World", result);
  }

  @Test
  void testResolveComplexExpression() {
    Map<String, Object> item = new HashMap<>();
    item.put("id", "test-123");
    item.put("type", "chapter");

    ExpressionContext context = ExpressionContext.builder()
        .item(item)
        .text("Sample content with multiple words")
        .index(2)
        .textLength(33)
        .textWords(5)
        .runId("run-001")
        .build();

    Object result = resolver.resolveTemplate(
        "Index: {{index}}, Words: {{textWords}}, Length: {{textLength}}", context);
    assertEquals("Index: 2, Words: 5, Length: 33", result);
  }

  @Test
  void testResolveWithGroovyExpression() {
    Map<String, Object> item = new HashMap<>();
    item.put("id", "test-123");
    item.put("type", "chapter");

    ExpressionContext context = ExpressionContext.builder()
        .item(item)
        .text("Sample content")
        .index(1)
        .runId("run-001")
        .build();

    // Test Groovy expression
    Object result =
        resolver.resolveTemplate("{{item.type.toUpperCase()}}-{{item.id}}-{{index + 1}}", context);
    assertEquals("CHAPTER-test-123-2", result);
  }

  @Test
  void testResolveWithEnvironmentVariables() {
    Map<String, String> env = new HashMap<>();
    env.put("API_KEY", "secret-key");
    env.put("REGION", "us-east-1");

    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("test")
        .env(env)
        .runId("run-001")
        .build();

    Object result =
        resolver.resolveTemplate("Key: {{env.API_KEY}}, Region: {{env.REGION}}", context);
    assertEquals("Key: secret-key, Region: us-east-1", result);
  }

  @Test
  void testResolveWithPipelineVariables() {
    Map<String, Object> variables = new HashMap<>();
    variables.put("book_name", "Test Book");
    variables.put("version", 2);

    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("test")
        .variables(variables)
        .runId("run-001")
        .build();

    Object result =
        resolver.resolveTemplate("Book: {{variables.book_name}} v{{variables.version}}", context);
    assertEquals("Book: Test Book v2", result);
  }

  @Test
  void testResolveNullAndEmptyTemplates() {
    ExpressionContext context = ExpressionContext.builder().build();

    assertNull(resolver.resolveTemplate(null, context));
    assertEquals("", resolver.resolveTemplate("", context));
    assertEquals("plain text", resolver.resolveTemplate("plain text", context));
  }

  @Test
  void testResolveMultipleExpressions() {
    Map<String, Object> item = new HashMap<>();
    item.put("id", "123");
    item.put("title", "Test Chapter");

    ExpressionContext context = ExpressionContext.builder()
        .item(item)
        .text("Chapter content")
        .index(0)
        .runId("run-001")
        .build();

    Object result = resolver.resolveTemplate(
        "Processing {{item.title}} ({{item.id}}) at index {{index}} in run {{runId}}", context);
    assertEquals("Processing Test Chapter (123) at index 0 in run run-001", result);
  }

  @Test
  void testResolveWithTextMetrics() {
    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("This is a test sentence with multiple words.")
        .textLength(43)
        .textWords(8)
        .textTokens(11) // Approximate
        .build();

    Object result = resolver.resolveTemplate(
        "Text: {{text}} ({{textLength}} chars, {{textWords}} words, ~{{textTokens}} tokens)",
        context);
    assertEquals(
        "Text: This is a test sentence with multiple words. (43 chars, 8 words, ~11 tokens)",
        result);
  }

  @Test
  void testResolveWithAggregationContext() {
    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("item content")
        .aggregationIndex(2)
        .aggregationText("batch content")
        .build();

    Object result =
        resolver.resolveTemplate("Batch {{aggregationIndex}}: {{aggregationText}}", context);
    assertEquals("Batch 2: batch content", result);
  }

  @Test
  void testResolveWithRetryAttempt() {
    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("test")
        .retryAttempt(2)
        .build();

    Object result = resolver.resolveTemplate("Attempt {{retryAttempt}} of 3", context);
    assertEquals("Attempt 2 of 3", result);
  }

  @Test
  void testResolveWithStateAndTool() {
    ExpressionContext context = ExpressionContext.builder()
        .item(new HashMap<>())
        .text("test")
        .state(StateDefinition.builder().name("PROCESSING").build())
        .tool(ToolDefinition.builder().name("text-processor").build())
        .build();

    Object result =
        resolver.resolveTemplate("Running {{tool.name}} in state {{state.name}}", context);
    assertEquals("Running text-processor in state PROCESSING", result);
  }

  @Test
  void testResolveWithConditionalExpression() {
    Map<String, Object> item = new HashMap<>();
    item.put("type", "chapter");
    item.put("skip", false);

    ExpressionContext context =
        ExpressionContext.builder().item(item).text("content").index(1).build();

    Object result = resolver.resolveTemplate(
        "{{item.type == 'preface' ? 'Skip' : 'Process'}} item {{index}}", context);
    assertEquals("Process item 1", result);
  }

  @Test
  void testResolveErrorHandling() {
    ExpressionContext context =
        ExpressionContext.builder().item(new HashMap<>()).text("test").build();

    assertThrows(RuntimeException.class, () -> {
      resolver.resolveTemplate("{{invalid.syntax.}}", context);
    });
  }
}
