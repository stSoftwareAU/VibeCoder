# Bucket: `java`

Canonical guides — link, do not restate:

- Effective Java (Joshua Bloch, 3rd ed.) — items referenced by number.
- Google Java Style Guide — <https://google.github.io/styleguide/javaguide.html>
- Java Language Specification — <https://docs.oracle.com/javase/specs/>

Apply these checks to `*.java`, `pom.xml`, and `build.gradle*`.

## Checks

1. **Nullability discipline.** Public methods document nullability
   via `@Nullable` / `@NonNull` (JSR-305, Checker Framework, or
   Spring's annotations). Flag `return null` from a method whose
   contract is non-null, and flag dereferences of values that the
   surrounding code has not null-checked. Effective Java item 54
   ("return empty collections or arrays, not nulls").
2. **`equals`/`hashCode` pair.** A class that overrides `equals` must
   override `hashCode` and vice versa. The two must be consistent
   (equal objects share a hash). Effective Java items 10–11. Flag
   overrides of only one of the pair.
3. **try-with-resources for `AutoCloseable`.** Streams, readers,
   writers, JDBC `Connection`/`Statement`/`ResultSet`, and any
   `AutoCloseable` are opened inside a `try (...)` block. Flag
   bare `try { ... } finally { x.close(); }` patterns and missing
   close calls.
4. **Immutability where possible.** Prefer `final` fields and
   defensive copies in constructors / accessors for mutable inputs
   (collections, dates, arrays). Records and immutable builders beat
   JavaBeans for value types. Effective Java items 17–18.
5. **Exception discipline.** Throw the most specific exception that
   describes the failure; never `throw new Exception(...)` or
   `throw new RuntimeException(...)` as a catch-all. Never swallow
   exceptions silently (`catch (Exception e) { }` is a defect).
   Effective Java items 70–77.
6. **Generics over raw types.** Public APIs use parameterised types;
   `List` (raw) is a defect, `List<?>` or `List<T>` is correct.
   Effective Java items 26–33.
7. **Static analysis configured.** `pom.xml` / `build.gradle`
   integrates one of SpotBugs, Error Prone, or Checkstyle in the
   build (not just the IDE). Flag missing static analysis on
   library or service projects.
8. **Logging over `System.out`.** Production code uses SLF4J
   (or `java.util.logging` if the project standard) with
   parameterised messages (`log.info("user {}", id)`) — never
   string concatenation. Flag `System.out.println` and
   `e.printStackTrace()` in production code paths.

## Dead dependencies

A "dead dependency" is a declared Maven or Gradle dep with no
`import` reference anywhere in the source tree. Dead deps inflate
build time and supply-chain risk and should be removed.

**Hard constraint — static evidence only.** This check greps `*.java`
files for `import` references. The scanner **does not** invoke `mvn`,
`gradle`, the `maven-dependency-plugin:analyze` goal, or the
`gradle-dependency-analyse` plug-in. Those plug-ins are the
production-grade tooling for the same job — note them in the
suggested fix so the human can confirm before deleting, but the
bucket check itself is read-only.

9. **Declared Maven/Gradle dep with no `import` reference.** Inspect:
   - `pom.xml` — every `<dependency>` entry in `<dependencies>` and
     in `<dependencyManagement>` that pins a coordinate the project
     consumes directly.
   - `build.gradle` / `build.gradle.kts` — every coordinate in the
     `dependencies { … }` block, across configurations
     (`implementation`, `api`, `compileOnly`, `runtimeOnly`,
     `testImplementation`, `testRuntimeOnly`, `annotationProcessor`).

   For each declared coordinate, identify the package(s) the artefact
   publishes (use the published `groupId:artifactId` mapping; for
   well-known artefacts the package prefix is documented). Then grep
   `*.java` under `src/main/`, `src/test/`, and any additional source
   roots for a real reference:
   - `import <package>.…;`
   - `import static <package>.…;`
   - fully-qualified references (`com.example.Foo.bar()`) outside any
     `import` block

   Test-scoped deps (`testImplementation`, `<scope>test</scope>`) must
   be searched against `src/test/` only; flagging a test-only dep as
   dead because nothing under `src/main/` references it is a false
   positive.

   Cite the offending manifest path and line range (e.g.
   `pom.xml:67-71` or `build.gradle:24`). Suggested fix: drop the
   declared dep, then run `mvn dependency:analyze` or the Gradle
   `dependencyAnalyse` task locally to confirm before merging. File
   at `severity:low` (hygiene); bump to `severity:medium` only if
   the dead dep is itself known-vulnerable.

## Deprecated config on framework bump

Build and framework configuration that survives a Gradle, Maven, or
Spring Boot bump but is no longer supported produces silent skew — the
deprecated configuration is ignored (or fails at a later phase) and the
build drifts from the contract the author believed they had. This check
flags those patterns when the manifest confirms the project is on the
toolchain version that changed the contract.

**Hard constraint — static evidence only.** This check reads `pom.xml`,
`build.gradle*`, and the toolchain version declared in
`gradle/wrapper/gradle-wrapper.properties`, `<parent>` /
`<spring-boot.version>`, or the Maven `<properties>` block. The scanner
**does not** invoke `gradle`, the `gradle wrapper` (`./gradlew`), `mvn`,
or any build command. **Read the manifest to confirm the project is
actually on the version that changed the contract — do not guess.**
Every finding is filed at `severity:medium` and must cite the offending
manifest path and line range (e.g. `build.gradle:24-27`). Use the
standard `BP-<12 hex>` stable-id recipe (title slug plus the primary
file) so re-runs deduplicate.

10. **Removed Gradle dependency configurations on Gradle 7+.** The
    `compile`, `runtime`, and `testCompile` configurations were
    deprecated in Gradle 5 and **removed in Gradle 7**. Flag their use
    in a `dependencies { … }` block when
    `gradle/wrapper/gradle-wrapper.properties` declares Gradle 7+.
    Suggested fix: replace `compile` → `implementation` (or `api` for
    transitively-exposed deps), `runtime` → `runtimeOnly`, and
    `testCompile` → `testImplementation`. Link the Gradle
    upgrade-your-build migration guide.
11. **Spring Boot 2.x config on a Spring Boot 3.x bump.** Spring Boot
    3.x **migrated the namespace from `javax.*` to `jakarta.*`** and
    requires Java 17+. Flag `javax.persistence`, `javax.servlet`,
    `javax.validation` (etc.) imports and a `spring-boot-starter-parent`
    / `spring-boot.version` already on 3.x — the surviving `javax.*`
    references will not resolve. Cite the import and the parent/version
    declaration. Suggested fix: rename `javax.*` → `jakarta.*` per the
    Spring Boot 3.0 migration guide.
12. **Maven `<plugin>` declaration missing a `<version>`.**
    Deterministic builds need explicit plugin pins; an unversioned
    `<plugin>` resolves to whatever the super-POM or a transitive bump
    supplies, which changes silently across upgrades. Flag any
    `<plugin>` in `<build><plugins>` / `<pluginManagement>` with no
    `<version>` child. Suggested fix: pin an explicit `<version>` (or
    declare it once in `<pluginManagement>`).
