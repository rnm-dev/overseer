import 'package:dio/dio.dart';

import '../application/connection_theme_controller.dart';

class DioConnectionThemeCatalogSource implements ConnectionThemeCatalogSource {
  DioConnectionThemeCatalogSource(this.dio);

  final Dio dio;

  @override
  Future<Object?> fetch() async {
    final response = await dio.get<Object>('v1/themes');
    return response.data;
  }
}
