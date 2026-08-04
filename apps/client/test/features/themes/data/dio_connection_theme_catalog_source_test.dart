import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/themes/data/dio_connection_theme_catalog_source.dart';

void main() {
  test('loads the public catalog below the configured API base URL', () async {
    RequestOptions? request;
    final dio = Dio(BaseOptions(baseUrl: 'https://overseer.example/api/'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          request = options;
          handler.resolve(
            Response<Object>(
              requestOptions: options,
              data: const {'format': 'overseer-theme-catalog-v1', 'themes': []},
              statusCode: 200,
            ),
          );
        },
      ),
    );

    final result = await DioConnectionThemeCatalogSource(dio).fetch();

    expect(request?.uri, Uri.parse('https://overseer.example/api/v1/themes'));
    expect(result, const {
      'format': 'overseer-theme-catalog-v1',
      'themes': <Object>[],
    });
  });
}
