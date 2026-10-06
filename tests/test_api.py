import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.main import ROOT, Trip, create_app, default_database_url


@pytest.fixture
def client(tmp_path):
    application = create_app(f"sqlite:///{tmp_path / 'test.db'}", seed=False)
    with TestClient(application) as test_client:
        yield test_client


def trip(**changes):
    return {"id": "t1", "start": "2026-10-01T08:10:00+05:00",
            "end": "2026-10-01T08:32:00+05:00", "amount": 2400,
            "payment": "card", "commission": 360, **changes}


def test_summary(client):
    assert client.post('/api/trips', json=trip()).status_code == 201
    client.post('/api/trips', json=trip(id='t2', start='2026-10-01T09:05:00+05:00',
                end='2026-10-01T09:20:00+05:00', amount=1500, payment='cash', commission=225))
    assert client.get('/api/summary?date=2026-10-01').json() == {
        'date': '2026-10-01', 'trips': 2, 'revenue': 3900,
        'commission': 585, 'net': 3315, 'cash': 1500, 'card': 2400}


def test_duplicate_returns_existing_and_one_database_row(client):
    first = client.post('/api/trips', json=trip())
    second = client.post('/api/trips', json=trip(amount=9000))
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json() == second.json()
    with client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Trip)) == 1


@pytest.mark.parametrize('changes', [
    {'id': ''}, {'id': '   '}, {'amount': 0}, {'amount': -1},
    {'commission': -1}, {'payment': 'bitcoin'},
    {'end': '2026-10-01T08:09:00+05:00'},
    {'end': '2026-10-01T08:10:00+05:00'},
    {'start': '2026-10-01T08:10:00'}, {'amount': 'NaN'}, {'amount': '1.001'},
])
def test_validation(client, changes):
    assert client.post('/api/trips', json=trip(**changes)).status_code == 422
    assert client.get('/api/trips?date=2026-10-01').json() == []


def test_overnight_uses_local_start_date(client):
    client.post('/api/trips', json=trip(start='2026-10-01T23:50:00+05:00',
                                     end='2026-10-02T00:15:00+05:00'))
    assert len(client.get('/api/trips?date=2026-10-01').json()) == 1
    assert client.get('/api/trips?date=2026-10-02').json() == []


def test_early_trip_uses_offset_date_not_utc(client):
    client.post('/api/trips', json=trip(start='2026-10-01T00:10:00+05:00',
                                     end='2026-10-01T00:30:00+05:00'))
    assert len(client.get('/api/trips?date=2026-10-01').json()) == 1
    assert client.get('/api/trips?date=2026-09-30').json() == []


def test_sorting_and_empty_day(client):
    client.post('/api/trips', json=trip(id='late', start='2026-10-01T11:00:00+05:00',
                                     end='2026-10-01T11:30:00+05:00'))
    client.post('/api/trips', json=trip(id='early'))
    assert [t['id'] for t in client.get('/api/trips?date=2026-10-01').json()] == ['early', 'late']
    assert client.get('/api/summary?date=2026-10-02').json() == {
        'date': '2026-10-02', 'trips': 0, 'revenue': 0,
        'commission': 0, 'net': 0, 'cash': 0, 'card': 0}


def test_decimal_money(client):
    client.post('/api/trips', json=trip(amount='0.30', commission='0.10'))
    assert client.get('/api/summary?date=2026-10-01').json()['net'] == 0.2


def test_bad_date(client):
    assert client.get('/api/trips?date=not-a-date').status_code == 422


def test_persistence_and_seed_idempotency(tmp_path):
    url = f"sqlite:///{tmp_path / 'persistent.db'}"
    with TestClient(create_app(url)) as client:
        assert len(client.get('/api/trips?date=2026-10-01').json()) == 2
        client.post('/api/trips', json=trip(id='saved'))
    with TestClient(create_app(url)) as client:
        assert len(client.get('/api/trips?date=2026-10-01').json()) == 3
        assert client.get('/').status_code == 200


def test_vercel_uses_writable_temporary_database(monkeypatch, tmp_path):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setattr('app.main.tempfile.gettempdir', lambda: str(tmp_path))
    assert default_database_url() == f"sqlite:///{(tmp_path / 'driver.db').as_posix()}"
    with TestClient(create_app()) as client:
        assert client.get('/').status_code == 200
        for path in ['/static/style.css', '/static/app.js', '/static/reference.png',
                     '/static/fonts/fonts.css', '/static/fonts/golos-0.ttf']:
            assert client.get(path).status_code == 200
        assert client.get('/api/summary?date=2026-10-01').json()['net'] == 3315
        assert client.post('/api/trips', json=trip(id='vercel-test')).status_code == 201
    assert (tmp_path / 'driver.db').is_file()


def test_local_default_keeps_persistent_database(monkeypatch):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    monkeypatch.delenv('VERCEL', raising=False)
    assert default_database_url() == f"sqlite:///{(ROOT / 'driver.db').as_posix()}"


def test_database_url_overrides_vercel_default(monkeypatch):
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setenv('DATABASE_URL', 'sqlite:////custom/diary.db')
    assert default_database_url() == 'sqlite:////custom/diary.db'
