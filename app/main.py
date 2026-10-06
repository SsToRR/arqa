from contextlib import asynccontextmanager
from datetime import date
from decimal import Decimal
import json
import os
from pathlib import Path
import tempfile
from typing import Literal

from fastapi import Depends, FastAPI, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import CheckConstraint, Numeric, String, create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

ROOT = Path(__file__).resolve().parent.parent


class Base(DeclarativeBase):
    pass


class Trip(Base):
    __tablename__ = "trips"
    __table_args__ = (
        CheckConstraint("amount > 0"),
        CheckConstraint("commission >= 0"),
        CheckConstraint("payment IN ('cash', 'card')"),
    )
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    start: Mapped[str] = mapped_column(String(40))
    end: Mapped[str] = mapped_column(String(40))
    start_day: Mapped[str] = mapped_column(String(10), index=True)
    start_epoch: Mapped[float]
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    payment: Mapped[str] = mapped_column(String(4))
    commission: Mapped[Decimal] = mapped_column(Numeric(14, 2))


class TripInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    start: AwareDatetime
    end: AwareDatetime
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    payment: Literal["cash", "card"]
    commission: Decimal = Field(ge=0, max_digits=14, decimal_places=2)

    @field_validator("id")
    @classmethod
    def nonempty_id(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Укажите ID поездки")
        return value

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end <= self.start:
            raise ValueError("Окончание должно быть позже начала поездки")
        return self


def record(data: TripInput) -> Trip:
    return Trip(
        id=data.id, start=data.start.isoformat(), end=data.end.isoformat(),
        start_day=data.start.date().isoformat(), start_epoch=data.start.timestamp(),
        amount=data.amount, payment=data.payment, commission=data.commission,
    )


def serialize(trip: Trip):
    return {"id": trip.id, "start": trip.start, "end": trip.end,
            "amount": trip.amount, "payment": trip.payment, "commission": trip.commission}


def default_database_url():
    configured = os.getenv("DATABASE_URL")
    if configured:
        return configured
    # Vercel has a read-only application directory and ephemeral scratch storage.
    directory = Path(tempfile.gettempdir()) if os.getenv("VERCEL") == "1" else ROOT
    return f"sqlite:///{(directory / 'driver.db').as_posix()}"


def create_app(database_url=None, *, seed=True):
    engine = create_engine(
        database_url or default_database_url(),
        connect_args={"check_same_thread": False},
    )
    factory = sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(application):
        Base.metadata.create_all(engine)
        if seed:
            with factory() as session:
                for item in json.loads((ROOT / "data/trips.json").read_text(encoding="utf-8")):
                    data = TripInput.model_validate(item)
                    if session.get(Trip, data.id) is None:
                        session.add(record(data))
                try:
                    session.commit()
                except IntegrityError:
                    session.rollback()
        yield
        engine.dispose()

    application = FastAPI(title="Дневник смен водителя", lifespan=lifespan)
    application.state.session_factory = factory

    def database():
        with factory() as session:
            yield session

    def day_trips(session, selected):
        return session.scalars(select(Trip).where(Trip.start_day == selected.isoformat())
                               .order_by(Trip.start_epoch, Trip.id)).all()

    @application.get("/api/trips")
    def get_trips(date: date = Query(...), session: Session = Depends(database)):
        return [serialize(trip) for trip in day_trips(session, date)]

    @application.get("/api/summary")
    def get_summary(date: date = Query(...), session: Session = Depends(database)):
        trips = day_trips(session, date)
        revenue = sum((trip.amount for trip in trips), Decimal(0))
        commission = sum((trip.commission for trip in trips), Decimal(0))
        return {"date": date.isoformat(), "trips": len(trips), "revenue": revenue,
                "commission": commission, "net": revenue - commission,
                "cash": sum((t.amount for t in trips if t.payment == "cash"), Decimal(0)),
                "card": sum((t.amount for t in trips if t.payment == "card"), Decimal(0))}

    @application.post("/api/trips", status_code=201)
    def add_trip(data: TripInput, response: Response, session: Session = Depends(database)):
        existing = session.get(Trip, data.id)
        if existing:
            response.status_code = 200
            return serialize(existing)
        trip = record(data)
        session.add(trip)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            existing = session.get(Trip, data.id)
            if existing is None:
                raise
            response.status_code = 200
            return serialize(existing)
        return serialize(trip)

    @application.get("/", include_in_schema=False)
    def index():
        return FileResponse(ROOT / "static/index.html")

    application.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return application


app = create_app()
