package machinum.manifest.io;

import java.util.Map;
import machinum.manifest.ToolsBody;
import machinum.manifest.ToolsBody.BootstrapToolManifest;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;

public class BootstrapToolManifestDeserializer extends ValueDeserializer<BootstrapToolManifest> {

  @Override
  public BootstrapToolManifest deserialize(JsonParser p, DeserializationContext ctxt)
      throws JacksonException {
    JsonNode node = ctxt.readTree(p);

    if (node == null || node.isMissingNode()) {
      return null;
    }

    if (node.isString()) {
      return ToolsBody.BootstrapToolManifest.builder().name(node.asString()).build();
    }

    if (node.isObject()) {
      var builder = ToolsBody.BootstrapToolManifest.builder();

      if (node.has("name")) {
        builder.name(node.get("name").asString());
      }

      if (node.has("description")) {
        builder.description(node.get("description").asString());
      }

      if (node.has("config")) {
        builder.config(ctxt.readTreeAsValue(
            node.get("config"),
            ctxt.getTypeFactory().constructMapType(Map.class, String.class, Object.class)));
      }

      return builder.build();
    }

    throw new IllegalArgumentException(
        "BootstrapToolManifest must be a string (tool name) or an object with name field");
  }
}
