package machinum.streamer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class SourceUriParserTest {

  @Test
  void shouldParseFileUriWithFormat() {
    var result = SourceUriParser.parse("file://src/main/chapters?format=md");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.FILE);
    assertThat(result.path()).isEqualTo("src/main/chapters");
    assertThat(result.getQueryParam("format")).isEqualTo("md");
  }

  @Test
  void shouldParseFileUriWithoutQueryParams() {
    var result = SourceUriParser.parse("file://src/main/chapters");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.FILE);
    assertThat(result.path()).isEqualTo("src/main/chapters");
    assertThat(result.getQueryParam("format")).isNull();
    assertThat(result.getQueryParam("format", "folder")).isEqualTo("folder");
  }

  @Test
  void shouldParseHttpUri() {
    var result = SourceUriParser.parse("http://example.com/data.json");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.HTTP);
    assertThat(result.path()).isEqualTo("http://example.com/data.json");
  }

  @Test
  void shouldParseHttpsUri() {
    var result = SourceUriParser.parse("https://api.example.com/items");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.HTTP);
    assertThat(result.path()).isEqualTo("https://api.example.com/items");
  }

  @Test
  void shouldParseScriptUri() {
    var result = SourceUriParser.parse("script://.mt/scripts/custom-loader.groovy");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.SCRIPT);
    assertThat(result.path()).isEqualTo(".mt/scripts/custom-loader.groovy");
  }

  @Test
  void shouldParseMultipleQueryParams() {
    var result = SourceUriParser.parse("file://data/input?format=jsonl&encoding=utf-8");

    assertThat(result.type()).isEqualTo(SourceUriParser.SourceType.FILE);
    assertThat(result.path()).isEqualTo("data/input");
    assertThat(result.getQueryParam("format")).isEqualTo("jsonl");
    assertThat(result.getQueryParam("encoding")).isEqualTo("utf-8");
  }

  @Test
  void shouldRejectNullUri() {
    assertThatThrownBy(() -> SourceUriParser.parse(null))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("cannot be null or empty");
  }

  @Test
  void shouldRejectEmptyUri() {
    assertThatThrownBy(() -> SourceUriParser.parse(""))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("cannot be null or empty");
  }

  @Test
  void shouldRejectUriWithoutSchema() {
    assertThatThrownBy(() -> SourceUriParser.parse("src/main/chapters"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("must have a schema");
  }

  @Test
  void shouldRejectUnsupportedSchema() {
    assertThatThrownBy(() -> SourceUriParser.parse("ftp://example.com/file"))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("Unsupported source URI schema");
  }
}
