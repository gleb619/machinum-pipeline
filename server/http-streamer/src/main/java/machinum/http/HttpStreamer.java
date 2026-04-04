package machinum.http;

import io.jooby.Jooby;
import io.jooby.jetty.JettyServer;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.JsonNodeFactory;

@Slf4j
@NoArgsConstructor(access = AccessLevel.PRIVATE)
public class HttpStreamer {

  private HttpStreamer init(Jooby app, Function<JsonNode, JsonNode> itemHandler) {
    var mapper = JsonMapper.builder().build();
    var nodeFactory = JsonNodeFactory.instance;

    app.before(ctx -> log.info("> {}", ctx.getRequestPath()));

    app.after((ctx, _, failure) -> {
      if (failure == null) {
        log.info("< {} {}", ctx.getRequestPath(), ctx.getResponseCode().value());
      } else {
        log.error("⤫ {} {}", ctx.getRequestPath(), ctx.getResponseCode(), failure);
      }
    });

    app.post("/items", ctx -> {
      JsonNode payload = ctx.body(JsonNode.class);

      try {
        var result = itemHandler.apply(payload);
        boolean isSuccess =
            !result.isEmpty() && result.has("success") && result.get("success").asBoolean();

        if (isSuccess) {
          var response = nodeFactory.objectNode();
          response.put("status", "ok");
          ctx.setResponseCode(200);
          return ctx.send(mapper.writeValueAsString(response));
        } else {
          var response = nodeFactory.objectNode();
          response.put("status", "failed");
          response.put("error", "Handler returned false");
          ctx.setResponseCode(400);
          return ctx.send(mapper.writeValueAsString(response));
        }
      } catch (Exception e) {
        var response = nodeFactory.objectNode();
        response.put("status", "failed");
        response.put("error", e.getMessage());
        ctx.setResponseCode(500);
        return ctx.send(mapper.writeValueAsString(response));
      }
    });

    return this;
  }

  public static JsonNode success() {
    return JsonNodeFactory.instance.objectNode().put("success", true);
  }

  public static JsonNode failed() {
    return JsonNodeFactory.instance.objectNode().put("success", false);
  }

  public static Runnable start(String[] args, Function<JsonNode, JsonNode> itemHandler) {
    AtomicReference<Runnable> closeHandler = new AtomicReference<>();
    Jooby.runApp(args, new JettyServer(), jooby -> {
      new HttpStreamer().init(jooby, itemHandler);
      closeHandler.set(jooby::stop);
    });

    return closeHandler.get();
  }

  public static void main(final String[] args) {
    start(args, payload -> {
      log.info("Received item: {}", payload.toPrettyString());
      return success();
    });
  }
}
