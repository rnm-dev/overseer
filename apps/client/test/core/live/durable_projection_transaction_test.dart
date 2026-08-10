import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/core/live/durable_projection_transaction.dart';

void main() {
  test(
    'crash rolls back the resource row and cursor; replay commits both',
    () async {
      final database = AppDatabase.forTesting(NativeDatabase.memory());
      addTearDown(database.close);
      final transaction = DurableProjectionTransaction(database);

      await expectLater(
        transaction.commit(
          workspaceId: 'workspace',
          cursor: 7,
          write: () async {
            await database
                .into(database.cachedWorkspaces)
                .insert(
                  CachedWorkspacesCompanion.insert(
                    workspaceId: 'workspace',
                    name: 'Partial',
                    syncedAt: 1,
                  ),
                );
            throw StateError('simulated crash before commit');
          },
        ),
        throwsStateError,
      );
      expect(await transaction.cursorFor('workspace'), 0);
      expect(await database.select(database.cachedWorkspaces).get(), isEmpty);

      await transaction.commit(
        workspaceId: 'workspace',
        cursor: 7,
        write: () => database
            .into(database.cachedWorkspaces)
            .insert(
              CachedWorkspacesCompanion.insert(
                workspaceId: 'workspace',
                name: 'Replayed',
                syncedAt: 1,
              ),
            ),
      );

      expect(await transaction.cursorFor('workspace'), 7);
      expect(
        (await database.select(database.cachedWorkspaces).getSingle()).name,
        'Replayed',
      );
    },
  );
}
