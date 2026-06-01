from pathlib import Path
from contextlib import closing

from football_value_app.db import connect
from football_value_app.importers import import_matches_csv
from football_value_app.service import analyze_fixture, list_leagues, list_teams


def test_demo_import_populates_stats_and_supports_analysis(tmp_path):
    db_path = tmp_path / "test.db"
    result = import_matches_csv(Path("sample_data/demo_matches.csv"), db_path)
    assert result == {"inserted": 24, "updated": 0}

    with closing(connect(db_path)) as connection:
        league = list_leagues(connection)[0]
        teams = {row["name"]: row["id"] for row in list_teams(connection, league["id"])}
        analysis = analyze_fixture(
            connection, league["id"], teams["Manchester United"], teams["Tottenham"]
        )

    assert analysis["home"]["matches_played"] == 12
    assert analysis["away"]["matches_played"] == 12
    assert analysis["league"]["matches_played"] == 24
    assert 0 < analysis["model"]["over_25_probability"] < 1


def test_import_updates_existing_result_instead_of_duplicating(tmp_path):
    db_path = tmp_path / "test.db"
    source = Path("sample_data/demo_matches.csv")
    import_matches_csv(source, db_path)
    result = import_matches_csv(source, db_path)
    assert result == {"inserted": 0, "updated": 24}


def test_football_data_headers_are_normalized(tmp_path):
    db_path = tmp_path / "test.db"
    source = tmp_path / "season.csv"
    source.write_text(
        "Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR\n"
        "2025-08-15,Liverpool,Bournemouth,4,2,H\n",
        encoding="utf-8",
    )
    result = import_matches_csv(
        source,
        db_path,
        league="Premier League",
        country="England",
        season="2025/26",
    )
    assert result == {"inserted": 1, "updated": 0}
