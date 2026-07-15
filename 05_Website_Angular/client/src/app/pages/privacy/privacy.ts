import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Header } from '../../layout/header/header';
import { Footer } from '../../layout/footer/footer';

/** Port of 04_Website/app/privacy.html — pure static content, no API calls. */
@Component({
  selector: 'app-privacy',
  standalone: true,
  imports: [RouterLink, Header, Footer],
  templateUrl: './privacy.html',
  styleUrl: './privacy.css',
})
export class Privacy {}
