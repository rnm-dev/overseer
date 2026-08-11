import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/projects/data/dio_project_detail_repository.dart';

void main() {
  test(
    'uses the web project detail contracts and decodes each surface',
    () async {
      final requests = <RequestOptions>[];
      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            final path = options.path;
            if (path.endsWith('/projects/mobile')) {
              return handler.resolve(
                Response<Map<String, dynamic>>(
                  requestOptions: options,
                  data: {
                    'projectId': 'project-id',
                    'key': 'mobile',
                    'name': 'Mobile',
                    'dir': '/projects/mobile',
                  },
                ),
              );
            }
            if (path.endsWith('/projects/mobile/settings')) {
              return handler.resolve(
                Response<Map<String, dynamic>>(
                  requestOptions: options,
                  data: {
                    'projectId': 'project-id',
                    'key': 'mobile',
                    'name': 'Mobile',
                    'dir': '/projects/mobile',
                    'metadata': null,
                  },
                ),
              );
            }
            if (path.endsWith('/projects/project-id/docs')) {
              return handler.resolve(
                Response<Map<String, dynamic>>(
                  requestOptions: options,
                  data: {
                    'exists': true,
                    'entries': [
                      {'name': 'index.md', 'type': 'file'},
                    ],
                  },
                ),
              );
            }
            if (path.endsWith('/projects/mobile/skills')) {
              return handler.resolve(
                Response<Map<String, dynamic>>(
                  requestOptions: options,
                  data: {
                    'skills': [
                      {
                        'name': 'review',
                        'description': 'Review the app.',
                        'path': '.agents/review/SKILL.md',
                      },
                    ],
                  },
                ),
              );
            }
            return handler.resolve(
              Response<List<int>>(
                requestOptions: options,
                data: '# Mobile'.codeUnits,
                headers: Headers.fromMap({
                  Headers.contentTypeHeader: ['text/markdown'],
                }),
              ),
            );
          },
        ),
      );
      final repository = DioProjectDetailRepository(dio: dio);

      final project = await repository.fetchProject(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectKey: 'mobile',
      );
      final settings = await repository.fetchSettings(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectKey: 'mobile',
      );
      final docs = await repository.fetchDocumentation(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectId: 'project-id',
      );
      final file = await repository.fetchFile(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectId: 'project-id',
        path: 'docs/index.md',
      );
      final skills = await repository.fetchSkills(
        workspaceId: 'workspace',
        peonId: 'peon',
        projectKey: 'mobile',
      );

      expect(project.displayName, 'Mobile');
      expect(settings.dir, '/projects/mobile');
      expect(docs.entries.single.name, 'index.md');
      expect(file.contentType, 'text/markdown');
      expect(skills.single.name, 'review');
      expect(
        requests.map((request) => request.path),
        contains(
          'workspaces/workspace/peons/peon/projects/by-id/project-id/files/docs/index.md',
        ),
      );
    },
  );
}
