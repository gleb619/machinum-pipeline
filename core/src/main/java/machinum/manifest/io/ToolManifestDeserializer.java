package machinum.manifest.io;

import machinum.manifest.ToolsBody;
import machinum.manifest.ToolsBody.ToolManifest;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;

public class ToolManifestDeserializer extends ValueDeserializer<ToolManifest> {

  @Override
  public ToolManifest deserialize(JsonParser p, DeserializationContext ctxt)
      throws JacksonException {
    JsonNode node = ctxt.readTree(p);

    if (node == null || node.isMissingNode()) {
      return null;
    }

    if (node.isString()) {
      return ToolsBody.ToolManifest.builder().name(node.asString()).build();
    }

    if (node.isObject()) {
      ToolsBody.ToolManifest.ToolManifestBuilder builder = ToolsBody.ToolManifest.builder();

      if (node.has("name")) {
        builder.name(node.get("name").asString());
      }

      if (node.has("description")) {
        builder.description(node.get("description").asString());
      }

      if (node.has("config")) {
        builder.config(
            ctxt.readTreeAsValue(node.get("config"), ToolsBody.ToolConfigManifest.class));
      }

      return builder.build();
    }

    throw new IllegalArgumentException(
        "ToolManifest must be a string (tool name) or an object with name field");
  }
}
