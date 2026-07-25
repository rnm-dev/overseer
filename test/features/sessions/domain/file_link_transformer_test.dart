import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/file_link_transformer.dart';

void main() {
  const transformer = FileLinkTransformer();
  const context = ProjectFileLinkContext(
    peonId: 'peon/id',
    projectId: 'project id',
    projectRoot: '/rnm/websitev2',
    currentOrigin: 'https://overseer.rnm.dev',
  );

  test('maps absolute project paths to canonical viewer links', () {
    expect(
      transformer
          .projectFile('/rnm/websitev2/docs/ivr sales.html#flow', context)
          ?.viewerHref,
      '/view/peon%2Fid/project%20id/docs/ivr%20sales.html#flow',
    );
    expect(
      transformer
          .projectFile('file:///rnm/websitev2/docs/index.html', context)
          ?.relativePath,
      'docs/index.html',
    );
    expect(
      transformer
          .projectFile(
            'https://overseer.rnm.dev/rnm/websitev2/docs/index.html?print=1',
            context,
          )
          ?.viewerHref,
      '/view/peon%2Fid/project%20id/docs/index.html?print=1',
    );
    expect(
      transformer
          .projectFile(
            r'C:\work\site\docs\index.html',
            const ProjectFileLinkContext(
              peonId: 'peon/id',
              projectId: 'project id',
              projectRoot: r'C:\work\site',
            ),
          )
          ?.relativePath,
      'docs/index.html',
    );
  });

  test('does not rewrite external, sibling, relative, or traversing links', () {
    expect(
      transformer.projectFile(
        'https://example.com/rnm/websitev2/docs/index.html',
        context,
      ),
      isNull,
    );
    expect(
      transformer.projectFile('/rnm/websitev20/docs/index.html', context),
      isNull,
    );
    expect(transformer.projectFile('/rnm/websitev2', context), isNull);
    expect(transformer.projectFile('docs/index.html', context), isNull);
    expect(
      transformer.projectFile('/rnm/websitev2/docs/../secret.html', context),
      isNull,
    );
  });

  test('maps canonical viewer URLs back to project-relative paths', () {
    expect(
      transformer.projectRelativePath(
        '/view/peon%2Fid/project%20id/docs/ivr%20sales.html#flow',
        context,
      ),
      'docs/ivr sales.html',
    );
    expect(
      transformer.projectRelativePath(
        '/view/other/project%20id/docs/index.html',
        context,
      ),
      isNull,
    );
    expect(
      transformer.projectRelativePath(
        '/view/peon%2Fid/project%20id/docs/%2E%2E/secret.html',
        context,
      ),
      isNull,
    );
  });

  test('recognizes local files and strips Codex source positions', () {
    expect(
      transformer.localFilePath('/work/lib/main.dart:12:4'),
      '/work/lib/main.dart',
    );
    expect(
      transformer.localFilePath('file:///work/lib/main.dart#L12-L18'),
      '/work/lib/main.dart',
    );
    expect(
      transformer.localFilePath(r'C:\work\lib\main.dart:12'),
      r'C:\work\lib\main.dart',
    );
    expect(transformer.localFilePath('docs/main.dart'), isNull);
    expect(transformer.localFilePath('https://example.com/main.dart'), isNull);
  });
}
