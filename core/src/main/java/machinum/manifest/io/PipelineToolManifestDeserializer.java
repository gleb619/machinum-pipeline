package machinum.manifest.io;

import java.util.List;
import machinum.manifest.PipelineToolManifest;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;

public class PipelineToolManifestDeserializer extends ValueDeserializer<PipelineToolManifest> {

  @Override
  public PipelineToolManifest deserialize(JsonParser p, DeserializationContext ctxt)
      throws JacksonException {
    JsonNode node = ctxt.readTree(p);

    if (node == null || node.isMissingNode()) {
      return null;
    }

    if (node.isString()) {
      return PipelineToolManifest.builder().name(node.asString()).build();
    }

    if (node.isObject()) {
      PipelineToolManifest.PipelineToolManifestBuilder builder = PipelineToolManifest.builder();

      if (node.has("tool")) {
        builder.name(node.get("tool").asString());
      } else if (node.has("name")) {
        builder.name(node.get("name").asString());
      }

      if (node.has("description")) {
        builder.description(node.get("description").asString());
      }

      if (node.has("async")) {
        builder.async(node.get("async").asBoolean(false));
      }

      if (node.has("input")) {
        builder.input(node.get("input").asString());
      }

      if (node.has("output")) {
        builder.output(node.get("output").asString());
      }

      if (node.has("tools")) {
        builder.tools(ctxt.readTreeAsValue(
            node.get("tools"),
            ctxt.getTypeFactory().constructCollectionType(List.class, PipelineToolManifest.class)));
      }

      return builder.build();
    }

    throw new IllegalArgumentException("PipelineToolManifest must be a string or an object");
  }
}
